// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Sharp from 'sharp';

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);

export const handler = async (event) => {
    const method = event?.requestContext?.http?.method;

    // Handle CORS preflight (OPTIONS)
    if (method === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '600',
            },
            body: '',
        };
    }

    // Reject anything that's not GET
    if (method !== 'GET') {
        return sendError(405, 'Only GET and OPTIONS methods are supported');
    }
    // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
    var imagePathArray = event.requestContext.http.path.split('/');
    // get the requested image operations
    var operationsPrefix = imagePathArray.pop();
    // get the original image path images/rio/1.jpg
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');

    var startTime = performance.now();
    // Downloading original image
    let originalImageBody;
    let contentType;
    try {
        const getOriginalImageCommand = new GetObjectCommand({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath });
        const getOriginalImageCommandOutput = await s3Client.send(getOriginalImageCommand);
        console.log(`Got response from S3 for ${originalImagePath}`);

        originalImageBody = getOriginalImageCommandOutput.Body.transformToByteArray();
        contentType = getOriginalImageCommandOutput.ContentType;
    } catch (error) {
        if (error.name === "NoSuchKey") {
          return sendError(404, "The requested image does not exist", error);
        }
        return sendError(500, 'Error downloading original image', error);
    }
    // If requested image is a PDF, return it
    if (contentType === 'application/pdf') {
        const pdfBuffer = await originalImageBody;
        return {
            statusCode: 200,
            body: Buffer.from(pdfBuffer).toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': 'application/pdf',
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
            }
        };
    }
    if (contentType === 'image/svg+xml' && !operationsPrefix.includes('width') && !operationsPrefix.includes('format')) {
        const svgBuffer = await originalImageBody;
        return {
            statusCode: 200,
            body: Buffer.from(svgBuffer).toString('base64'),
            isBase64Encoded: true,
            headers: {
                'Content-Type': 'image/svg+xml',
                'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
                'Access-Control-Allow-Origin': '*',
            }
        };
    }

    let transformedImage = Sharp(await originalImageBody, { failOn: 'none', animated: true });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    // execute the requested operations 
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    // variable holding the server timing header value
    var timingLog = 'img-download;dur=' + parseInt(performance.now() - startTime);
    startTime = performance.now();
    try {
        // check if resizing is requested
        var resizingOptions = {};
        if (operationsJSON['width']) resizingOptions.width = parseInt(operationsJSON['width']);
        if (operationsJSON['height']) resizingOptions.height = parseInt(operationsJSON['height']);
        if (resizingOptions) transformedImage = transformedImage.resize(resizingOptions);
        // check if rotation is needed
        if (imageMetadata.orientation) transformedImage = transformedImage.rotate();
        // check if formatting is requested
        console.log(`S3 Content-Type: ${contentType}`);
        if (contentType === 'image/heic' || originalImagePath.toLowerCase().endsWith('.heic') || contentType === 'application/octet-stream') {
            contentType = 'image/jpeg';
            transformedImage = transformedImage.toFormat('jpeg', { quality: 80 });
        } else if (operationsJSON['format']) {
            var isLossy = false;
            switch (operationsJSON['format']) {
                case 'jpeg': contentType = 'image/jpeg'; isLossy = true; break;
                case 'gif': contentType = 'image/gif'; break;
                case 'webp': contentType = 'image/webp'; isLossy = true; break;
                case 'png': contentType = 'image/png'; break;
                case 'avif': contentType = 'image/avif'; isLossy = true; break;
                default: contentType = 'image/jpeg'; isLossy = true;
            }
            if (operationsJSON['quality'] && isLossy) {
                transformedImage = transformedImage.toFormat(operationsJSON['format'], {
                    quality: parseInt(operationsJSON['quality']),
                });
            } else {
                transformedImage = transformedImage.toFormat(operationsJSON['format']);
            }
        }
        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }
    timingLog = timingLog + ',img-transform;dur=' + parseInt(performance.now() - startTime);

    // handle gracefully generated images bigger than a specified limit (e.g. Lambda output object limit)
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    // upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        startTime = performance.now();
        try {
            const putImageCommand = new PutObjectCommand({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
            })
            await s3Client.send(putImageCommand);
            timingLog = timingLog + ',img-upload;dur=' + parseInt(performance.now() - startTime);
            // If the generated image file is too big, send a redirection to the generated image on S3, instead of serving it synchronously from Lambda. 
            if (imageTooBig) {
                return {
                    statusCode: 302,
                    headers: {
                        'Location': '/' + originalImagePath + '?' + operationsPrefix.replace(/,/g, "&"),
                        'Cache-Control': 'private,no-store',
                        'Server-Timing': timingLog
                    }
                };
            }
        } catch (error) {
            logError('Could not upload transformed image to S3', error);
        }
    }

    // Return error if the image is too big and a redirection to the generated image was not possible, else return transformed image
    if (imageTooBig) {
        return sendError(403, 'Requested transformed image is too big', '');
    } else return {
        statusCode: 200,
        body: transformedImage.toString('base64'),
        isBase64Encoded: true,
        headers: {
            'Content-Type': contentType,
            'Cache-Control': TRANSFORMED_IMAGE_CACHE_TTL,
            'Server-Timing': timingLog,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '600'
        }
    };
};

function sendError(statusCode, body, error) {
    logError(body, error);
    return { statusCode, body };
}

function logError(body, error) {
    console.log('APPLICATION ERROR', body);
    console.log(error);
}
