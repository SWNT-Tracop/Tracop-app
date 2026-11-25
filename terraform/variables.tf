variable "region" {
  description = "Región AWS."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "Tipo de instancia EC2 (t3.small: 2 GB para el build del monorepo)."
  type        = string
  default     = "t3.small"
}

variable "ami_id" {
  description = "AMI de Ubuntu 22.04 LTS. Vacío para resolverlo por catálogo (por defecto)."
  type        = string
  default     = ""
}

variable "repo_url" {
  description = "Repositorio del backend (se clona y se compila en la propia EC2; sin ECR)."
  type        = string
  default     = "https://github.com/SWNT-Tracop/Tracop-app.git"
}

variable "repo_branch" {
  description = "Rama a desplegar."
  type        = string
  default     = "main"
}

variable "api_port" {
  description = "Puerto público de la API."
  type        = number
  default     = 3100
}

variable "ssh_cidr" {
  description = "CIDR desde el que se permite SSH. 0.0.0.0/0 para la demo."
  type        = string
  default     = "0.0.0.0/0"
}
