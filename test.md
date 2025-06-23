nvm use 20
npm run build
cdk deploy -c S3_IMAGE_BUCKET_NAME='ecom-assets-production' --profile production