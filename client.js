class Clients {
    constructor() {
        this.allClients = {};
        this.saveClient = this.saveClient.bind(this);
        this.requestLimit = 10;
    }

    saveClient(uuid, connection) {
        this.allClients[uuid] = { connection: connection, requests: 0 };
    }

    getNumberOfClients() {
        return Object.keys(this.allClients).length;
    }

    deleteClient(uuid) {
        delete this.allClients[uuid];
    }

    printAllClients() {
        console.log('Printing all connected clients');
        var keys = Object.keys(this.allClients);
        for (var i = 0; i < keys.length; i++) {
            console.log(keys[i]);
        }
    }
}

let clients = new Clients();

module.exports = clients;