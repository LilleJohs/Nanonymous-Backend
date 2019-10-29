const dpowUserName = process.env.DPOW_USER;
const dpowApiKey = process.env.DPOW_API_KEY;

const WebSocketClient = require('websocket').client;
const redisWork = require('./redisWork');

// Try to reconnect every 5 seconds to DPoW if connection closed
const reconnectInterval = 1000 * 5;

let workRequests = 0;
let dpowConnection;

let hashWeAreWaitingFor = [];

function connect() {
    const client = new WebSocketClient();
    client.connect('wss://dpow.nanocenter.org/service_ws/');
    client.on('connectFailed', function (error) {
        console.error('DPoW connection error 1: ' + error.toString());
    });

    client.on('connect', function (connection) {
        console.log('Connected to DPoW');
        dpowConnection = connection;

        connection.on('close', function () {
            console.log('DPoW Connection Closed');
            console.log('Reconnecting in 5 seconds');
            setTimeout(() => connect(), reconnectInterval);
        });
        connection.on('message', async function (message) {
            if (message.type === 'utf8') {
                console.log("Sent work request and received from DPoW. Total work requests: " + workRequests);
                const data = JSON.parse(message.utf8Data);
                await redisWork.setWork(data.hash, data.work);

                // Remove hash from list of pending hash work after been saved to redis
                var index = hashWeAreWaitingFor.indexOf(data.hash);
                if (index !== -1) {
                    hashWeAreWaitingFor.splice(index, 1);
                }
            }
        });
    });
};
connect();


function askForWork(hash) {
    if (dpowConnection.connected) {
        // if (workRequests > 30) {
        //     // Only debugging. Making sure Im not spamming their server
        //     console.error('Too many requests to DPoW. Restart the server');
        //     return false;
        // }
        var index = hashWeAreWaitingFor.indexOf(hash);
        if (index !== -1) {
            // Request for this hash already been requested. Avoids duplication
            return true;
        }
        workRequests++;
        const request = {
            "user": dpowUserName,
            "api_key": dpowApiKey,
            "hash": hash
        };
        timer = Date.now();
        dpowConnection.sendUTF(JSON.stringify(request));
        hashWeAreWaitingFor.push(hash);
        return true;
    } else {
        return false;
    }
}

function connectedToDPoW() {
    // Only process send blocks if we are connected to DPoW
    return dpowConnection.connected;
}

module.exports.askForWork = askForWork
module.exports.connectedToDPoW = connectedToDPoW;