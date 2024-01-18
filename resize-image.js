// 'use strict';

// const querystring = require('querystring');

// const AWS = require('aws-sdk');
// const S3 = new AWS.S3({
//   signatureVersion: 'v4',
// });
// const Sharp = require('sharp');

// // set the S3 and API GW endpoints
// const BUCKET = 'image-resize';

// exports.handler = (event, context, callback) => {
//     console.log(JSON.stringify(event), 'event');
//   let response = event.Records[0].cf.response;

//   console.log("Response status code :%s", response.status);

//   //check if image is not present
//   if (response.status == 404) {

//     let request = event.Records[0].cf.request;
//     let params = querystring.parse(request.querystring);

//     // if there is no dimension attribute, just pass the response
//     if (!params.d) {
//       callback(null, response);
//       return;
//     }

//     // read the dimension parameter value = width x height and split it by 'x'
//     let dimensionMatch = params.d.split("x");

//     // read the required path. Ex: uri /images/100x100/webp/image.jpg
//     let path = request.uri;

//     // read the S3 key from the path variable.
//     // Ex: path variable /images/100x100/webp/image.jpg
//     let key = path.substring(1);

//     // parse the prefix, width, height and image name
//     // Ex: key=images/200x200/webp/image.jpg
//     let prefix, originalKey, match, width, height, requiredFormat, imageName;
//     let startIndex;

//     try {
//       match = key.match(/(.*)\/(\d+)x(\d+)\/(.*)\/(.*)/);
//       prefix = match[1];
//       width = parseInt(match[2], 10);
//       height = parseInt(match[3], 10);

//       // correction for jpg required for 'Sharp'
//       requiredFormat = match[4] == "jpg" ? "jpeg" : match[4];
//       imageName = match[5];
//       originalKey = prefix + "/" + imageName;
//     }
//     catch (err) {
//       // no prefix exist for image..
//       console.log("no prefix present..");
//       match = key.match(/(\d+)x(\d+)\/(.*)\/(.*)/);
//       width = parseInt(match[1], 10);
//       height = parseInt(match[2], 10);

//       // correction for jpg required for 'Sharp'
//       requiredFormat = match[3] == "jpg" ? "jpeg" : match[3]; 
//       imageName = match[4];
//       originalKey = imageName;
//     }

//     // get the source image file
//     S3.getObject({ Bucket: BUCKET, Key: originalKey }).promise()
//       // perform the resize operation
//       .then(data => Sharp(data.Body)
//         .resize(width, height)
//         .toFormat(requiredFormat)
//         .toBuffer()
//       )
//       .then(buffer => {
//         // save the resized object to S3 bucket with appropriate object key.
//         S3.putObject({
//             Body: buffer,
//             Bucket: BUCKET,
//             ContentType: 'image/' + requiredFormat,
//             CacheControl: 'max-age=31536000',
//             Key: key,
//             StorageClass: 'STANDARD'
//         }).promise()
//         // even if there is exception in saving the object we send back the generated
//         // image back to viewer below
//         .catch(() => { console.log("Exception while writing resized image to bucket")});

//         // generate a binary response with resized image
//         response.status = 200;
//         response.body = buffer.toString('base64');
//         response.bodyEncoding = 'base64';
//         response.headers['content-type'] = [{ key: 'Content-Type', value: 'image/' + requiredFormat }];
//         callback(null, response);
//       })
//     .catch( err => {
//       console.log("Exception while reading source image :%j",err);
//     });
//   } // end of if block checking response statusCode
//   else {
//     // allow the response to pass through
//     callback(null, response);
//   }
// };

const AWS = require('aws-sdk');
const https = require('https');
const Sharp = require('sharp');

const S3 = new AWS.S3({ signatureVersion: 'v4', httpOptions: { agent: new https.Agent({ keepAlive: true }) } });
const S3_ORIGINAL_IMAGE_BUCKET = process.env.S3_ORIGINAL_IMAGE_BUCKET;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.S3_ORIGINAL_IMAGE_BUCKET;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.TRANSFORMED_IMAGE_CACHE_TTL;
const SECRET_KEY = process.env.SECRET_KEY;
const MAX_IMAGE_SIZE = parseInt(process.env.MAX_IMAGE_SIZE);

exports.handler = async (event) => {
    // First validate if the request is coming from CloudFront
    if (!event.headers['x-origin-secret-header'] || !(event.headers['x-origin-secret-header'] === SECRET_KEY)) return sendError(403, 'Request unauthorized', event);
    // Validate if this is a GET request
    if (!event.requestContext || !event.requestContext.http || !(event.requestContext.http.method === 'GET')) return sendError(400, 'Only GET method is supported', event);
    // An example of expected path is /images/rio/1.jpeg/format=auto,width=100 or /images/rio/1.jpeg/original where /images/rio/1.jpeg is the path of the original image
    var imagePathArray = event.requestContext.http.path.split('/');
    // get the requested image operations
    var operationsPrefix = imagePathArray.pop();
    // get the original image path images/rio/1.jpg
    imagePathArray.shift();
    var originalImagePath = imagePathArray.join('/');

    var startTime = performance.now();
    // Downloading original image
    let originalImage;
    let contentType;
    try {
        originalImage = await S3.getObject({ Bucket: S3_ORIGINAL_IMAGE_BUCKET, Key: originalImagePath }).promise();
        contentType = originalImage.ContentType;
    } catch (error) {
        return sendError(500, 'error downloading original image', error);
    }
    let transformedImage = Sharp(originalImage.Body, { failOn: 'none', animated: true });
    // Get image orientation to rotate if needed
    const imageMetadata = await transformedImage.metadata();
    //  execute the requested operations 
    const operationsJSON = Object.fromEntries(operationsPrefix.split(',').map(operation => operation.split('=')));
    // variable holding the server timing header value
    var timingLog =  'img-download;dur=' + parseInt(performance.now() - startTime);
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
        if (operationsJSON['format']) {
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
            } else transformedImage = transformedImage.toFormat(operationsJSON['format']);
        }
        transformedImage = await transformedImage.toBuffer();
    } catch (error) {
        return sendError(500, 'error transforming image', error);
    }
    timingLog = timingLog + ',img-transform;dur=' +parseInt(performance.now() - startTime);

    // Graceful handleing of generated images bigger than a specified limit (e.g. Lambda output object limit)
    const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

    // upload transformed image back to S3 if required in the architecture
    if (S3_TRANSFORMED_IMAGE_BUCKET) {
        startTime = performance.now();
        try {
            await S3.putObject({
                Body: transformedImage,
                Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
                Key: originalImagePath + '/' + operationsPrefix,
                ContentType: contentType,
                Metadata: {
                    'cache-control': TRANSFORMED_IMAGE_CACHE_TTL,
                },
            }).promise();
            timingLog = timingLog + ',img-upload;dur=' +parseInt(performance.now() - startTime);
            // If the generated image file is too big, send a redirection to the generated image on S3, instead of serving it synchronously from Lambda. 
            if (imageTooBig) {
                return {
                    statusCode: 302,
                    headers: {
                        'Location': '/' + originalImagePath + '?' + operationsPrefix.replace(/,/g, "&"),
                        'Cache-Control' : 'private,no-store',
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
            'Server-Timing': timingLog
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
