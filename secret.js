const AWS = require('aws-sdk');

async function getSecret() {
    const secretName = "527GroupProject";
    const region = "us-east-1"; // 确保这与您的Secrets Manager所在区域匹配

    const client = new AWS.SecretsManager({
        region: region
    });

    try {
        const data = await client.getSecretValue({ SecretId: secretName }).promise();
        if ('SecretString' in data) {
            return JSON.parse(data.SecretString);
        } else {
            let buff = new Buffer(data.SecretBinary, 'base64');
            return JSON.parse(buff.toString('ascii'));
        }
    } catch (err) {
        console.error("Error retrieving secret: ", err);
        throw err;
    }
}

module.exports = { getSecret };