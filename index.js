"use strict";

const WebSocketServer = require('websocket').server;
const http = require('http');
const processRequest = require('./processRequest');
const uuidv4 = require('uuid/v4');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const server = http.createServer(function (request, response) {
});
server.listen(5000, function () { });


const wsServer = new WebSocketServer({
  httpServer: server
});

// Object of all clients using uuid to store every active connection
let clients = require('./client');

const rateLimiter = new RateLimiterMemory(
  {
    points: 5,
    duration: 1,
  });

wsServer.on('request', function (request) {
  let connection = request.accept(null, request.origin);
  const uuid = uuidv4();
  clients.saveClient(uuid, connection);
  console.log('New client connected. Clients connected: ' + clients.getNumberOfClients());

  connection.on('message', async function (message) {
    try {
      await rateLimiter.consume(uuid);
    } catch (rejRes) {
      console.log('Disconnecting due to spam from ' + connection.remoteAddress);
      connection.close();
      return;
    }

    if (message.type === 'utf8') {
      try {
        const data = JSON.parse(message.utf8Data);
        if ('title' in data) {
          switch (data.title) {
            case 'VERSION_NUMBER': {
              if ('versionNumber' in data) {
                processRequest.versionNumber(connection, data.versionNumber);
              }
            }
              break;

            case 'GET_ACCOUNTS_INFO': {
              if ('accounts' in data && 'accountsHistory' in data) {
                processRequest.getAccountInfo(connection, data.accounts, data.accountsHistory);
              } else {
                throw 'Invalid request';
              }
            }
              break;

            case 'PROCESS_RECEIVE_BLOCK': {
              if ('block' in data) {
                const blockData = JSON.parse(data.block);
                processRequest.createReceiveBlock(connection, blockData);
              } else {
                throw 'Invalid request';
              }
            }
              break;

            case 'PROCESS_SEND_BLOCKS': {
              if ('firstBlocks' in data && 'lastFirstBlock' in data && 'lastSecondBlock' in data) {
                const firstBlocks = JSON.parse(data.firstBlocks);
                const lastFirstBlock = JSON.parse(data.lastFirstBlock);
                const lastSecondBlock = JSON.parse(data.lastSecondBlock);
                processRequest.createSendBlocks(connection, firstBlocks, lastFirstBlock, lastSecondBlock);
              } else {
                throw 'Invalid request';
              }
            }
              break;

            default: {
              throw 'Wrong title: ' + data.title;
            }
          }
        } else {
          throw 'No title';
        }
      } catch (e) {
        if (typeof (e) == "string") {
          connection.sendUTF(
            JSON.stringify({
              'title': 'error',
              'message': e
            }));
        } else {
          connection.sendUTF(
            JSON.stringify({
              'title': 'error',
              'name': e.name,
              'message': e.message
            }));
        }
      }
    }
  });

  connection.on('close', function (connection) {
    // Connection closed
    clients.deleteClient(uuid);
    console.log('Client disconnected. Clients connected: ' + clients.getNumberOfClients());
  });
});

