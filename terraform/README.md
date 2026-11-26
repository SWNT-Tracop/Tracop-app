# Despliegue con Terraform (AWS, cuenta real)

Infraestructura de la **demo para jurados**: una EC2 con el stack completo (API + worker + PostgreSQL, storage en **S3**, sin MinIO), dos buckets S3 (media privado y web público) y un rol IAM para que la API acceda a S3.

> La imagen se compila en la propia EC2 (sin ECR). Todo lo que toca AWS queda declarado acá: EC2, security group, clave SSH, buckets S3 y el rol/policy de S3.

## 1. Requisitos

- **Terraform** ≥ 1.5 y **AWS CLI** instalados.
- Credenciales de AWS con permisos para crear EC2, S3 e IAM (un usuario admin).

## 2. Credenciales (locales, nunca en el chat ni en el repo)

```bash
aws configure                          # Access Key + Secret Access Key + región us-east-1
```

## 3. Aplicar

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

El `apply` crea: instancia EC2 (con el rol IAM de S3), dos buckets S3, security group y clave SSH. El `user-data` de la EC2 instala Docker, clona el repo y levanta el stack (tarda 5–10 min en el primer arranque).

## 4. Salidas

```bash
terraform output -raw api_url            # URL para API_BASE_URL de la app
terraform output -raw web_endpoint       # URL pública de la Flutter Web
terraform output -raw media_bucket       # bucket de media
terraform output -raw ssh_private_key_pem > tracop.pem && chmod 600 tracop.pem
terraform output -raw ssh_public_ip      # IP para entrar por SSH
```

Los logs del bootstrap quedan en `/var/log/tracop-bootstrap.log`. El OTP de los usuarios sintéticos se imprime en `docker compose -f docker-compose.aws.yml --env-file .env.demo logs api` dentro de la instancia.

## Notas

- **Costo:** con free tier, la EC2 `t3.small`, el S3 y la IP pública entran dentro de los límites gratuitos de 12 meses (una sola instancia). Ajustá `instance_type` si querés `t3.micro`.
- **CORS de la web:** para que la Flutter Web funcione desde el navegador, fijá `CORS_ALLOWED_ORIGINS` en la API con `terraform output -raw web_endpoint`. El APK no necesita CORS.
- **Destruir:** `terraform destroy` borra todo, incluida la EC2. Los buckets S3 no se borran si tienen objetos.
