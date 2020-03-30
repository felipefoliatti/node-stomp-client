var assert = require('assert');
var net = require('net');
var tls = require('tls');
var util = require('util');
var events = require('events');
var StompFrame = require('./frame').StompFrame;
var StompFrameEmitter = require('./parser').StompFrameEmitter;

// Copied from modern node util._extend, because it didn't exist
// in node 0.4.
function _extend(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || typeof add !== 'object') return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

// Inbound frame validators
var StompFrameCommands = {
  '1.0': {
    'CONNECTED': {
      'headers': { 'session': { required: true } }
    },
    'MESSAGE' : {
      'headers': {
        'destination': { required: true },
        'message-id': { required: true }
      }
    },
    'ERROR': {},
    'RECEIPT': {}
  },
  '1.1': {
    'CONNECTED': {
      'headers': { 'session': { required: true } }
    },
    'MESSAGE' : {
      'headers': {
        'destination': { required: true },
        'message-id': { required: true }
      }
    },
    'ERROR': {},
    'RECEIPT': {}
  }
};

function StompClient(address, port, user, pass, protocolVersion, vhost, reconnectOpts, heartBeat, tlsOpts) {
  events.EventEmitter.call(this);
  this.user = (user || '');
  this.pass = (pass || '');
  this.address = (address || '127.0.0.1');
  this.port = (port || 61613);
  this.version = (protocolVersion || '1.0');
  this.heartBeat = heartBeat || '0,0'
  this.subscriptions = {};
  assert(StompFrameCommands[this.version], 'STOMP version '+this.version+' is not supported');
  this._stompFrameEmitter = new StompFrameEmitter(StompFrameCommands[this.version]);
  this.vhost = vhost || null;
  this.reconnectOpts = reconnectOpts || {};
  this._retryNumber = 0;
  this._retryDelay = this.reconnectOpts.delay;
  
  if(tlsOpts === true) {
      tlsOpts = {};
  }
  this.tls = tlsOpts;

  return this;
}

util.inherits(StompClient, events.EventEmitter);

StompClient.prototype.connect = function (connectedCallback, errorCallback) {
  var self = this;

  //reset this field.
  delete this._disconnectCallback;

  if (errorCallback) {
    self.on('error', errorCallback);
  }

  if(this.tls) {
    self.stream = tls.connect(self.port, self.address, this.tls);
  }
  else {
    self.stream = net.createConnection(self.port, self.address);
  }

  //self.stream = net.createConnection(self.port, self.address);
  self.stream.on('connect', self.onConnect.bind(this));

  self.stream.on('error', function(err) {
    process.nextTick(function() {
      //clear all of the stomp frame emitter listeners - we don't need them, we've disconnected.
      self._stompFrameEmitter.removeAllListeners();
    });
    self.stopHeartBeats();
    if (self._retryNumber < self.reconnectOpts.retries) {
      if (self._retryNumber === 0) {
        //we're disconnected, but we're going to try and reconnect.
        self.emit('reconnecting');
      }
      self._reconnectTimer = setTimeout(function() {
        self.connect();
      }, self._retryNumber++ * self.reconnectOpts.delay)
    } else {
      if (self._retryNumber === self.reconnectOpts.retries) {
        err.message += ' [reconnect attempts reached]';
        err.reconnectionFailed = true;
      }
      self.emit('error', err);
    }
  });

  if (connectedCallback) {
    self.on('connect', connectedCallback);
  }
  return this;
};

StompClient.prototype.disconnect = function (callback) {
  var self = this;

  //just a bit of housekeeping. Remove the no-longer-useful reconnect timer.
  if (self._reconnectTimer) {
    clearTimeout(self._reconnectTimer);
  }

  if (this.stream) {
    //provide a default no-op function as the callback is optional
    this._disconnectCallback = callback || function() {};

    var frame = new StompFrame({
      command: 'DISCONNECT'
    }).send(this.stream);

    process.nextTick(function() {
      self.stream.end();
    });
  }

  return this;
};

StompClient.prototype.onConnect = function() {

  var self = this;

  // First set up the frame parser
  var frameEmitter = self._stompFrameEmitter;

  self.stream.on('data', function(data) {
    self.onDataReceived = new Date().getTime();
    frameEmitter.handleData(data);
  });

  self.stream.on('end', function() {
    if (self._disconnectCallback) {
      self._disconnectCallback();
    } else {
      self.stream.emit('error', new Error('Server has gone away'));
    }
  });

  frameEmitter.on('MESSAGE', function(frame) {
    var subscribed = self.subscriptions[frame.headers.destination];
    // .unsubscribe() deletes the subscribed callbacks from the subscriptions,
    // but until that UNSUBSCRIBE message is processed, we might still get
    // MESSAGE. Check to make sure we don't call .map() on null.
    if (subscribed) {
      subscribed.listeners.map(function(callback) {
        callback(frame.body, frame.headers);
      });
    }
  });

  frameEmitter.on('CONNECTED', function(frame) {
    self.initializeHeartbeats(frame, self);
    if (self._retryNumber > 0) {
      //handle a reconnection differently to the initial connection.
      self.emit('reconnect', frame.headers.session, self._retryNumber);
      self._retryNumber = 0;
    } else {
      self.emit('connect', frame.headers.session);
    }
  });

  frameEmitter.on('ERROR', function(frame) {
    var er = new Error(frame.headers.message);
    // frame.headers used to be passed as er, so put the headers on er object
    _extend(er, frame.headers);
    self.emit('error', er, frame.body);
  });

  frameEmitter.on('parseError', function(err) {
    // XXX(sam) err should be an Error object to more easily track the
    // point of error detection, but it isn't, so create one now.
    var er = new Error(err.message);
    if (err.details) {
      er.details = err.details;
    }
    self.emit('error', er);
    //when connections hand, end is not enougth to disconnect - so we destroy the entire connection
    self.stream.destroy();
  });

  // Send the CONNECT frame
  var headers = {
    'login': self.user,
    'passcode': self.pass
  };

  if('1.0' !== self.version) {
    headers['accept-version'] = self.version;
    headers['heart-beat'] = self.heartBeat;
  }

  if(this.vhost && this.version === '1.1')
    headers.host = this.vhost;

  var frame = new StompFrame({
    command: 'CONNECT',
    headers: headers
  }).send(self.stream);

  //if we've just reconnected, we'll need to re-subscribe
  for (var queue in self.subscriptions) {
    new StompFrame({
      command: 'SUBSCRIBE',
      headers: self.subscriptions[queue].headers
    }).send(self.stream);
  }
};

StompClient.prototype.subscribe = function(queue, _headers, _callback) {
  // Allow _headers or callback in any order, for backwards compat: so headers
  // is whichever arg is not a function, callback is whatever is left over.
  var callback;
  if (typeof _headers === 'function') {
    callback = _headers;
    _headers = null;
  }
  if (typeof _callback === 'function') {
    callback = _callback;
    _callback = null;
  }
  // Error now, preventing errors thrown from inside the 'MESSAGE' event handler
  assert(callback, 'callback is mandatory on subscribe');

  var headers = _extend({}, _headers || _callback);
  headers.destination = queue;
  if (!(queue in this.subscriptions)) {
    this.subscriptions[queue] = {
      listeners: [],
      headers: headers
    };
    new StompFrame({
      command: 'SUBSCRIBE',
      headers: headers
    }).send(this.stream);
  }
  this.subscriptions[queue].listeners.push(callback);
  return this;
};

// no need to pass a callback parameter as there is no acknowledgment for
// successful UNSUBSCRIBE from the STOMP server
StompClient.prototype.unsubscribe = function (queue, headers) {
  headers = _extend({}, headers);
  headers.destination = queue;
  new StompFrame({
    command: 'UNSUBSCRIBE',
    headers: headers
  }).send(this.stream);
  delete this.subscriptions[queue];
  return this;
};

StompClient.prototype.publish = function(queue, message, headers) {
  var self = this;
  headers = _extend({}, headers);
  headers.destination = queue;
  headers.receipt = headers["correlation-id"]; //use the correlation-id, if set, to control the response
  
  let promise = null;
  if(headers.receipt){
    
    promise = new Promise((resolve, reject) => {
      let onData = null;
      let onTimeout = null;
      let id = null;

     
      //define the onData to handle each data arrived - if the correct arrived, remove the onData
      onData = function(frame){
        frame = frame || '';
        if ( frame.includes('RECEIPT') && frame.includes(headers.receipt)) {
          self.stream.removeListener('data', onData);
          clearTimeout(id);
          resolve();
        }
      }

      //define the timeout to reject the promise
      onTimeout = function(){
        //remove the listner
        self.stream.removeListener('data', onData);
        reject(new Error('timeout waiting the RECEIPT from server'));
      };

      //define the timeout to reject the promise - 10s
      id = setTimeout(onTimeout, 10000);

      //define the callback for any data received
      self.stream.on('data', onData);  
    }); 
  }
  
  new StompFrame({
    command: 'SEND',
    headers: headers,
    body: message
  }).send(this.stream);

  return promise || Promise.resolve();
};

StompClient.prototype.initializeHeartbeats = function(frame) {
  var self = this;
  if(frame.headers && frame.headers['heart-beat']) {
    var heartBeats = frame.headers['heart-beat'].split(',');
    var maxClientExpectedRateMilliseconds = parseInt(heartBeats[0]);
    var maxServerExpectedRateMilliseconds = parseInt(heartBeats[1]);
    var clientForgiveness = maxServerExpectedRateMilliseconds;
    
    self.heartBeatFailures = 0;

    self.onDataReceived = new Date().getTime();
    self.outboundHeartBeatInterval = setInterval(function() {
      self.stream.write('\n');
    }, maxServerExpectedRateMilliseconds);

    self.inboundHeartBeatInterval = setInterval(function() {
      var timeBetweenLastDataAndNow = new Date().getTime() - self.onDataReceived;
      if(timeBetweenLastDataAndNow > (maxClientExpectedRateMilliseconds + clientForgiveness)) {
        self.heartBeatFailures++;
        if(self.heartBeatFailures > 2) {
          
          //self.stream.emit('reconnect', new Error('Failed 3 heartbeats: Last message was sent ' + timeBetweenLastDataAndNow +"ms ago."));
          self.stopHeartBeats();

          self.stream.emit('error', new Error('Failed 3 heartbeats: Last message was sent ' + timeBetweenLastDataAndNow +"ms ago."));
          self.stream.destroy();
          
        }
      } else {
        self.heartBeatFailures = 0;
      }
    }, maxClientExpectedRateMilliseconds);
  }
};

StompClient.prototype.stopHeartBeats = function() {
  if(this.outboundHeartBeatInterval) {
    clearInterval(this.outboundHeartBeatInterval);
    delete this.outboundHeartBeatInterval;
  }
  if(this.inboundHeartBeatInterval) {
    clearInterval(this.inboundHeartBeatInterval);
    delete this.inboundHeartBeatInterval;
  }
  delete this.onDataReceived
};

function sendAckNack(acknack, messageId, subscription, transaction) {
  var headers = {
    'message-id': messageId,
    'subscription': subscription
  };
  if(transaction) {
    headers['transaction'] = transaction;
  }
  new StompFrame({
    command: acknack,
    headers: headers
  }).send(this.stream);
}

StompClient.prototype.ack = function(messageId, subscription, transaction) {
  sendAckNack.call(this, 'ACK', messageId, subscription, transaction);
  return this;
};

StompClient.prototype.nack = function(messageId, subscription, transaction) {
  sendAckNack.call(this, 'NACK', messageId, subscription, transaction);
  return this;
};

Object.defineProperty(StompClient.prototype, 'writable', {
  get: function(){
    return this.stream && this.stream.writable;
  }
});

function SecureStompClient(address, port, user, pass, credentials) {
  events.EventEmitter.call(this);
  var self = this;
  self.user = user;
  self.pass = pass;
  self.subscriptions = {};
  self.stream = net.createConnection(port, address);
  self.stream.on('connect', function() {
    self.stream.setSecure(credentials);
  });
  self.stream.on('secure', function() {
    self.onConnect();
  });
}

util.inherits(SecureStompClient, StompClient);

module.exports = StompClient;
module.exports.StompClient = StompClient;
module.exports.SecureStompClient = SecureStompClient;

module.exports.Errors = {
  streamNotWritable: 15201
};