BUCKET="imgtransformationstack-s3transformedimagebucket6d8-9tmyjfaohm2u"
PREFIX="2023"

aws s3api list-objects-v2 --bucket $BUCKET --query 'Contents[].Key' --output text --profile production| \
  tr '\t' '\n' | \
  split -l 1000 - delete_batch_

for file in delete_batch_*; do
  echo "Deleting batch $file..."
  jq -n --argfile keys <(jq -R . $file | jq -s '[.[] | {Key: .}]') \
    '{Objects: $keys}' > payload.json
  aws s3api delete-objects --bucket "$BUCKET" --delete file://payload.json --profile production
  rm $file
done

rm payload.json