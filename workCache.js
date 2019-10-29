const redis = require('redis');
const axios = require('axios');
const Promise = require('bluebird');
const Queue = require('bull');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);
let clients = require('./client');

const redisClient = redis.createClient();

redisClient.on("error", function (err) {
  console.log(err);
});

const workQueue = new Queue('work', {
  defaultJobOptions: { removeOnComplete: true }
});

workQueue.process(async function (job, done) {
  clients.printAllClients();
  const hash = job.data.hash;
  const reply = await redisClient.getAsync(hash);
  if (reply == null) {
    try {
      console.log(`Calculating work for hash: ${hash}`);
      const start = Date.now();
      const getWorkJSON = JSON.stringify({
        "action": "work_generate",
        "hash": hash
      });
      const workResponse = await axios.post('http://[::1]:7076', getWorkJSON);
      console.log("Time to caclulate hash:", (Date.now() - start) / 1000, "seconds");
      if (workResponse.data.hasOwnProperty('error')) {
        throw `Error from Nano node: ${workResponse.data.error}`;
      }
      redisClient.set(hash, workResponse.data.work, 'EX', 86400);
      done(null, workResponse.data.work);
    } catch (e) {
      done(new Error(e))
    }
  } else {
    console.log('Work is already in cache');
    done(null, reply);
  }
});

workQueue.on('completed', async (job, result) => {
  const data = job.data;
  console.log(`Made work for hash ${data.hash}`);
  if (!(Object.entries(data.blockData).length === 0 && data.blockData.constructor === Object)) {
    //Process block since blockdata is not empty
    console.log('Processing block as urgent');
    let jsonWithoutWork = data.blockData;
    jsonWithoutWork['work'] = result;
    processBlock(jsonWithoutWork, null, data.uuid);
  }
});
workQueue.on('failed', function (job, error) {
  console.log('Queue error: ' + error.message);
});

async function processBlock(blockJson, connection, uuid) {
  const jsonString = JSON.stringify(blockJson);
  const jsonProcess = JSON.stringify({
    "action": "process",
    "block": jsonString
  });

  const response = await axios.post('http://[::1]:7076', jsonProcess);
  const responseData = response.data;
  if (!responseData.hasOwnProperty('error')) {
    console.log('Sending block sucessfully and telling the connection');
    if (connection != null) {
      connection.sendUTF(
        JSON.stringify({
          'title': 'TX_IS_PROCESSED',
          'account': blockJson.account,
          'type': blockJson.subtype
        }));
    } else if (uuid != null) {
      const connectionFromUuid = clients[uuid];
      connection.sendUTF(
        JSON.stringify({
          'title': 'TX_IS_PROCESSED',
          'account': blockJson.account,
          'type': blockJson.subtype
        }));
    }

    redisClient.delAsync(blockJson.previous);
    cacheWork({
      previousHash: responseData.hash,
      urgent: false,
      blockData: {},
      uuid: null
    });
  } else {
    console.log('Error while proessing block:');
    console.log(responseData.error);

    if (connection != null) {
      connection.sendUTF(
        JSON.stringify({
          'title': 'error',
          'message': responseData.error
        }));
    }
  }
}

async function cacheWork({ previousHash, urgent, blockData, uuid }) {
  if (previousHash == null) {
    return 'PreviousHash is null or undefined';
  }
  const reply = await redisClient.getAsync(previousHash);
  const priority = urgent ? 1 : 2;
  if (reply !== null) {
    console.log("Work is already cached with hash: " + previousHash + " nounce: " + reply);
    return reply;
  } else {
    const allJobs = await workQueue.getJobs();
    for (let j = 0; j < allJobs.length; j++) {
      if (allJobs[j].data.hash === previousHash) {
        if (urgent) {
          // If the job is already in queue and we want to send right away, we want to send the trasnaction
          // after work has been calculated
          const jobState = await allJobs[j].getState();
          if (jobState !== 'active') {
            // Delete job and add the same job with high priority and block data
            console.log('Job is not active so we remove it and give it a higher priority');
            await allJobs[j].remove();
          } else {
            // The job is already active so we only add a new job with high priority
            console.log('Job IS active so we just add a new job with block data');
          }
          workQueue.add({ hash: previousHash, blockData: blockData, uuid: uuid }, { priority: priority });
        }
        return 'IN_QUEUE';
      }
    }

    workQueue.add({ hash: previousHash, blockData: blockData, uuid: uuid }, { priority: priority });
    return 'IN_QUEUE';
  }
}

// async function isWorkValid(previousHash) {
//   if (previousHash == null) {
//     return false;
//   }
//   const work = await redisClient.getAsync(previousHash);
//   if (work === null) {
//     return false;
//   } else {
//     const validJSON = JSON.stringify({
//       "action": "work_validate",
//       "work": work,
//       "hash": previousHash
//     });
//     const validResponse = await axios.post('http://[::1]:7076', validJSON);
//     if (validResponse.data.valid === "1") {
//       return true;
//     } else {
//       return false;
//     }
//   }
// }

function setWork(hash, work) {
  console.log('Setting work for hash: ' + hash);
  redisClient.set(hash, work, 'EX', 86400);
}

//module.exports.isWorkValid = isWorkValid;
module.exports.setWork = setWork;
module.exports.cacheWork = cacheWork;
module.exports.processBlock = processBlock;