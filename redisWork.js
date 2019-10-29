const axios = require('axios');
const redis = require('redis');
const Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

const redisClient = redis.createClient();

redisClient.on("error", function (err) {
    console.error(new Error('Error when connecting to redis: ' + err));
});

async function getWork(hash) {
    const work = await redisClient.getAsync(hash);
    return work;
}

async function setWork(hash, work) {
    await redisClient.setAsync(hash, work, 'EX', 86400);
}

async function processBlock(blockJson) {
    const jsonString = JSON.stringify(blockJson);
    const jsonProcess = JSON.stringify({
        "action": "process",
        "block": jsonString
    });

    const response = await axios.post('http://[::1]:7076', jsonProcess);
    const responseData = response.data;
    redisClient.delAsync(blockJson.previous);
    if (!responseData.hasOwnProperty('error')) {
        return true;
    } else {
        console.error('Error while processing block:', responseData.error);
        return false;
    }
}

module.exports.getWork = getWork;
module.exports.setWork = setWork;
module.exports.processBlock = processBlock;