const crypto = require('crypto');
const exifr = require('exifr');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

exports.processDocument = async (fileKey) => {
    try {
        const command = new GetObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileKey
        });
        const s3Response = await s3.send(command);
        const buffer = Buffer.from(await s3Response.Body.transformToByteArray());

        const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

        let isForged = false;
        let latitude = null;
        let longitude = null;

        try {
            const exifData = await exifr.parse(buffer, { gps: true, tiff: true });
            if (exifData) {
                const software = (exifData.Software || '').toLowerCase();
                if (software.includes('photoshop') || software.includes('canva') || software.includes('snapseed')) {
                    isForged = true;
                }
                if (exifData.latitude && exifData.longitude) {
                    latitude = exifData.latitude;
                    longitude = exifData.longitude;
                }
            }
        } catch (exifErr) {
            console.warn("No EXIF data found or file is not an image.");
        }

        return { buffer, fileHash, isForged, latitude, longitude };
    } catch (error) {
        console.error("Document Processing Error:", error);
        throw new Error("Failed to process document metadata");
    }
};