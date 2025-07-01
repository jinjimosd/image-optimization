aws s3 ls s3://your-transformed-bucket/ --recursive | \
  awk '{print $4}' | \
  grep '.svg/' | \
  while read key; do
    aws s3 rm "s3://your-transformed-bucket/$key"
done