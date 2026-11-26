# Infraestructura de la demo para AWS (cuenta real, free tier).
#
# Una EC2 (t3.small) con Docker Compose corre API + worker + PostgreSQL; el storage
# de objetos usa Amazon S3 (sin MinIO). La imagen se compila en la propia instancia
# (sin ECR). Incluye un rol IAM para que la API acceda al bucket S3 vía instance profile.
#
# Requiere credenciales de AWS en el entorno (aws configure o variables de entorno).
# Nunca se guardan en el repo.

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# --- AMI (Ubuntu 22.04 LTS desde el catálogo de EC2) ---
data "aws_ami" "ubuntu" {
  count       = var.ami_id == "" ? 1 : 0
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ami = var.ami_id != "" ? var.ami_id : data.aws_ami.ubuntu[0].id
}

# --- Sufijo para nombres globalmente únicos ---
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  media_bucket = "tracop-media-${random_string.suffix.result}"
  web_bucket   = "tracop-web-${random_string.suffix.result}"
}

# --- IAM: rol + policy + instance profile para que la EC2 acceda a S3 ---
resource "aws_iam_role" "ec2_s3" {
  name = "tracop-ec2-s3-${random_string.suffix.result}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "ec2_s3" {
  name = "tracop-ec2-s3-${random_string.suffix.result}"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
      ]
      Resource = [
        "arn:aws:s3:::${local.media_bucket}",
        "arn:aws:s3:::${local.media_bucket}/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ec2_s3" {
  role       = aws_iam_role.ec2_s3.name
  policy_arn = aws_iam_policy.ec2_s3.arn
}

resource "aws_iam_instance_profile" "ec2_s3" {
  name = "tracop-ec2-s3-${random_string.suffix.result}"
  role = aws_iam_role.ec2_s3.name
}

# --- Bucket S3 de media (privado; fotos y comprobantes) ---
resource "aws_s3_bucket" "media" {
  bucket = local.media_bucket
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Bucket S3 web (público, hosting de la Flutter Web) ---
resource "aws_s3_bucket" "web" {
  bucket = local.web_bucket
}

resource "aws_s3_bucket_website_configuration" "web" {
  bucket = aws_s3_bucket.web.id
  index_document { suffix = "index.html" }
  error_document { key = "index.html" }
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadGetObject"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.web.arn}/*"
    }]
  })
}

# --- Clave SSH para entrar a la EC2 ---
resource "tls_private_key" "ssh" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_key_pair" "ssh" {
  key_name   = "tracop-${random_string.suffix.result}"
  public_key = tls_private_key.ssh.public_key_openssh
}

# --- Security group: SSH + API ---
resource "aws_security_group" "app" {
  name        = "tracop-${random_string.suffix.result}"
  description = "TRACOP demo: SSH + API"

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_cidr]
  }

  ingress {
    from_port   = var.api_port
    to_port     = var.api_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --- EC2: clona, compila y levanta el stack demo (sin MinIO, storage en S3) ---
resource "aws_instance" "app" {
  ami                    = local.ami
  instance_type          = var.instance_type
  key_name               = aws_key_pair.ssh.key_name
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2_s3.name

  user_data = templatefile("${path.module}/user-data.sh.tpl", {
    repo_url     = var.repo_url
    repo_branch  = var.repo_branch
    media_bucket = local.media_bucket
    region       = var.region
    api_port     = var.api_port
  })

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
  }

  tags = { Name = "tracop-${random_string.suffix.result}" }
}
