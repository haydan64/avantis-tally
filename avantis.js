//This includes all the nodejs functions and event listeners for the Avantis.



class avantis extends EventEmitter {

    constructor(avantisAddress) {
        super();
        this.connection = null;
        this.avantisAddress = avantisAddress;
    }

    connect() {

    }

}

module.exports = {
    avantis
}