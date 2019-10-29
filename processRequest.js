const axios = require('axios');
const nanocurrency = require('nanocurrency');
const dpow = require('./dpow');
const redisWork = require('./redisWork');

let succesfulTxs = 0;
let unsuccesfulTxs = 0;

async function getAccountInfo(connection, accounts, accountsWithHistory) {
  try {
    const accountBalancesJSON = JSON.stringify({
      "action": "accounts_balances",
      "accounts": accounts
    });
    const pendingJSON = JSON.stringify({
      "action": "accounts_pending",
      "accounts": accounts,
      "count": "1000",
      "threshold": "1000000000000000000000000",
      "include_only_confirmed": "true"
    });
    const frontiersJSON = JSON.stringify({
      "action": "accounts_frontiers",
      "accounts": accounts
    });

    const accountBalancesResponse = await axios.post('http://[::1]:7076', accountBalancesJSON);
    const balancesInfoData = accountBalancesResponse.data.balances;

    const pendingResponse = await axios.post('http://[::1]:7076', pendingJSON);
    const pendingData = pendingResponse.data.blocks;

    const frontiersResponse = await axios.post('http://[::1]:7076', frontiersJSON);
    const frontiersData = frontiersResponse.data.frontiers;

    for (var i = 0; i < accounts.length; i++) {
      const account = accounts[i];

      let whatShouldBeHashed;
      if (frontiersData.hasOwnProperty(account)) {
        // If account has a frontier, then the work is based on that hash
        whatShouldBeHashed = frontiersData[account];
      } else {
        // If account does not have a frontier, it does not have an open block
        // and so the work is based on the public key derived from the account
        const publicKey = nanocurrency.derivePublicKey(account);
        whatShouldBeHashed = publicKey;
      }

      // Make sure we start caching work for all accounts with index above minimumIndex
      redisWork.getWork(whatShouldBeHashed)
        .then(work => {
          if (work == null) {
            dpow.askForWork(whatShouldBeHashed);
          }
        });
    }

    let allHistory = [];
    for (var i = 0; i < accountsWithHistory.length; i++) {
      const account = accountsWithHistory[i];
      const historyJSON = JSON.stringify({
        "action": "account_history",
        "account": account,
        "count": "100"
      });
      const historyResponse = await axios.post('http://[::1]:7076', historyJSON);
      const historyData = historyResponse.data;
      allHistory.push(historyData);
    }

    const completeJSON = {
      balancesInfoData: balancesInfoData === "" ? [] : balancesInfoData,
      historyData: allHistory === "" ? [] : allHistory,
      pendingData: pendingData === "" ? [] : pendingData,
      frontiersData: frontiersData === "" ? [] : frontiersData
    };

    connection.sendUTF(
      JSON.stringify({
        'title': 'ACCOUNTS_INFO',
        'data': completeJSON
      }));
  } catch (e) {
    console.error('Error while fetching account info:', e);
    connection.sendUTF(
      JSON.stringify({
        'title': 'error',
        'name': e.name,
        'message': e.message
      }));
  }
}

async function createReceiveBlock(connection, block) {
  const wasBlockProcessed = await createOneBlock(block);
  if (wasBlockProcessed) {
    connection.sendUTF(
      JSON.stringify({
        'title': 'TX_IS_PROCESSED',
        'account': block.account,
        'subtype': 'receive'
      }));
  } else {
    console.error('Not able to proccess receive block');
    connection.sendUTF(
      JSON.stringify({
        'title': 'errorOnProcessingReceive'
      }));
  }
}

function createSendBlocks(connection, firstBlocks, lastFirstBlock, lastSecondBlock) {
  // firstBlocks are all blocks that empties an account. And lastFirstBlock and lastSecondBlock
  // First push all send blocks that empties the accounts in firstBlocks.
  // The two last blocks (lastFirstBlock and lastSecondBlock) may need to be in correct order.
  // The client makes the following random choice if there is leftover Nano.
  // Either 1.
  //    firstBlocks are all blocks to receiver, lastFirstBlock is a send block to ourself
  //    and lastSecondBlock is the open(receiver) block to the new account the client owns.
  //    In this case the order of the two last blocks is important.
  // Or 2.
  //    firstBlocks contain all send blocks to receiver and one send block to ourself.
  //    lastFirstBlock contains the last send block to receiver and lastSecondBlock is
  //    still the open(receiver) block for our leftover Nano. In this case the order of
  //    the two last blocks is not important, but since we don't know which of the two
  //    cases we are in, we always follow this order.

  // Send all blocks in firstBlocks

  if (!dpow.connectedToDPoW()) {
    // If we are not connected to DPoW we shouldn't even try sending the blocks
    unsuccesfulTxs++;
    console.error('Not connected to DPoW. No blocks sent. Ratio successful txs:', getSuccessRatio());
    connection.sendUTF(
      JSON.stringify({
        'title': 'ERROR_PROCESSING_SEND'
      }));
    return;
  }

  let allPromises = [];
  for (var i = 0; i < firstBlocks.length; i++) {
    const blockPromise = createOneBlock(firstBlocks[i]);
    allPromises.push(blockPromise);
  }
  Promise.all(allPromises).then(async function (values) {
    // Check if the all were processed successfully
    let wereAllProcessed = true;
    for (let i = 0; i < values.length; i++) {
      wereAllProcessed = values[i];
      if (!wereAllProcessed) { break; }
    }

    // If there is a change transaction
    if (lastFirstBlock != null) {
      const lastFirstBlockPromise = await createOneBlock(lastFirstBlock);
      const lastSecondBlockPromise = await createOneBlock(lastSecondBlock);
      wereAllProcessed = (lastFirstBlockPromise && lastSecondBlockPromise);
    }

    // If all blocks were processed correctly
    if (wereAllProcessed) {
      succesfulTxs++;
      console.log('All blocks were successfully sent. Ratio successful txs:', getSuccessRatio());
      connection.sendUTF(
        JSON.stringify({
          'title': 'TX_IS_PROCESSED',
          'account': (lastSecondBlock == null) ? firstBlocks[firstBlocks.length - 1].account : lastSecondBlock.account,
          'subtype': 'send'
        }));
    } else {
      unsuccesfulTxs++;
      console.error('NOT all blocks were successfully sent. Ratio successful txs:', getSuccessRatio());
      connection.sendUTF(
        JSON.stringify({
          'title': 'ERROR_PROCESSING_SEND'
        }));
    }
  });
}

async function createOneBlock(block) {
  if (!block.hasOwnProperty('work')) {
    console.log('No work field');
  }
  const workHash = block.work;
  let jsonWithoutWork = {
    "type": "state",
    "subtype": block.subtype,
    "account": block.account,
    "previous": block.previous,
    "representative": block.representative,
    "balance": block.balance,
    "link": block.link,
    "signature": block.signature
  };

  let nounce = await redisWork.getWork(workHash);

  if (nounce == null || nounce == '') {
    // Nounce does not exist and so we have to wait for DPoW and then process
    // If nounce=='' then DPoW has already been asked for work and we just need to wait
    if (nounce == null) {
      const doingWork = dpow.askForWork(workHash);
      if (!doingWork) {
        console.error('No way to get work since DPoW is not responding 1');
        return false;
      }
    }

    const processResponse = await waitForWorkAndProcess(workHash, jsonWithoutWork);
    return processResponse;
  } else {
    // Nounce is ready so we just process it right away
    jsonWithoutWork['work'] = nounce;
    const processReponse = await redisWork.processBlock(jsonWithoutWork);
    return processReponse;
  }
}

async function waitForWorkAndProcess(workHash, jsonWithoutWork) {
  // Ask dpow for work, and then wait until we receive it in Redis
  return new Promise(resolve => {
    waitForWork(workHash, async newNounce => {
      if (newNounce == '') {
        console.error('No way to get work since DPoW is not responding 2');
        return false;
      }
      jsonWithoutWork['work'] = newNounce;
      const processReponse = await redisWork.processBlock(jsonWithoutWork);
      resolve(processReponse);
    });
  });
}

async function waitForWork(hash, callback) {
  // Checks every 200ms if we work has arrived in Redis
  // Timeout after 5 seconds
  const startTime = Date.now();
  var interval = setInterval(async function () {
    if (Date.now() - startTime > 5000) {
      clearInterval(interval);
      callback('');
    }
    const nounce = await redisWork.getWork(hash);
    if (nounce != null) {
      clearInterval(interval);
      callback(nounce);
    }
  }, 200);
}

function versionNumber(connection, versionNumber) {
  // Send error message. In case of a critical bug and the user should update their app

  // connection.sendUTF(
  //   JSON.stringify({
  //     'title': 'MESSAGE_FROM_SERVER',
  //     'message': 'You are using an old version number. Please update.'
  //   }));
}

function getSuccessRatio() {
  return Math.round(succesfulTxs / (unsuccesfulTxs + succesfulTxs) * 100).toString() + '%: Succesful:' + succesfulTxs.toString();
}

module.exports.versionNumber = versionNumber;
module.exports.getAccountInfo = getAccountInfo;
module.exports.createReceiveBlock = createReceiveBlock;
module.exports.createSendBlocks = createSendBlocks;
