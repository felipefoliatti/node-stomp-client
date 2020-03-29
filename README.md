Stomp Client
===========

This repository is a fork from [ahudak](https://github.com/ahudak), adding a promise response for publish method.
Ahudak implemented the heart-beat that check if the server is alive.
But when the Queue goes down without notifying the underlying TCP conenction and therefore not notifying the stream, the stream remains open and publish will be lost. This repository also add a check, waiting the server answer. 

The following enhancements have been added:

*   Control heart-beat (added by [ahudak](https://github.com/ahudak))
*   Added promise to publish to control when server return the RECEIPT

## Installation

	npm install git+https://github.com/felipefoliatti/node-stomp-client.git

## Super basic example

    var Stomp = require('stomp-client');
    var destination = '/queue/someQueueName';
    var client = new Stomp('127.0.0.1', 61613, 'user', 'pass');

    client.connect(function(sessionId) {
        client.subscribe(destination, function(body, headers) {
          console.log('This is the body of a message on the subscribed queue:', body);
        });

        client.publish(destination, 'Oh herrow');
    });

The client comes in two forms, a standard or secure client. The example below is
using the standard client. To use the secure client simply change
`StompClient` to `SecureStompClient`


# API

## Queue Names

The meaning of queue names is not defined by the STOMP spec, but by the Broker.
However, with ActiveMQ, they should begin with `"/queue/"` or with `"/topic/"`, see
[STOMP1.0](http://stomp.github.io/stomp-specification-1.0.html#frame-SEND) for
more detail.

## Stomp = require('stomp-client')

Require returns a constructor for STOMP client instances.

For backwards compatibility, `require('stomp-client').StompClient` is also
supported.

## Stomp(address, [port], [user], [pass], [protocolVersion], [reconnectOpts], [heartBeat])

- `address`: address to connect to, default is `"127.0.0.1"`
- `port`: port to connect to, default is `61613`
- `user`: user to authenticate as, default is `""`
- `pass`: password to authenticate with, default is `""`
- `protocolVersion`: see below, defaults to `"1.0"`
- `reconnectOpts`: see below, defaults to `{}`
- `heartBeat`: se below, defaults to `"0,0"`

reconnectOpts should contain an integer `retries` specifying the maximum number
of reconnection attempts, and a `delay` which specifies the reconnection delay.
 (reconnection timings are calculated using exponential backoff. The first reconnection
 happens immediately, the second reconnection happens at `+delay` ms, the third at `+ 2*delay` ms, etc).

heartBeat should contain a string separated by , containing two integers values in milliseconds. The first value (maxServerExpectedRateMilliseconds) refers to interval where a byte is sent to server. The second value (maxClientExpectedRateMilliseconds) refers to the interval where the client check if servers answer. The client check maxClientExpectedRateMilliseconds three times before rise an "reconnect".
An example is `"3000,6000"`.

## stomp.connect([callback, [errorCallback]])

Connect to the STOMP server. If the callbacks are provided, they will be
attached on the `'connect'` and `'error'` event, respectively.

## virtualhosts

If using virtualhosts to namespace your queues, you must pass a `version` header of '1.1' otherwise it is ignored.

## stomp.disconnect(callback)

Disconnect from the STOMP server. The callback will be executed when disconnection is complete.
No reconnections should be attempted, nor errors thrown as a result of this call.

## stomp.subscribe(queue, [headers,] callback)

- `queue`: queue to subscribe to
- `headers`: headers to add to the SUBSCRIBE message
- `callback`: will be called with message body as first argument,
  and header object as the second argument

## stomp.unsubscribe(queue, [headers])

- `queue`: queue to unsubscribe from
- `headers`: headers to add to the UNSUBSCRIBE message

## stomp.publish(queue, message, [headers])

- `queue`: queue to publish to
- `message`: message to publish, a string or buffer
- `headers`: headers to add to the PUBLISH message

This method returns a Promise.
If `correlation-id` header is set, then the `receipt` header will be set and this method return a promise that will `resolve` when server send a RECEIPT, answering the publish. It will reject after 20s without any response from server.
If `correlation-id` is not set, the `receipt` header will not be set and the promise will resolve instantly.

## stomp.ack(messageId, subscription, [transaction]),
## stomp.nack(messageId, subscription, [transaction])

- `messageId`: the id of the message to ack/nack
- `subscription`: the id of the subscription
- `transaction`: optional transaction name

## Property: `stomp.publishable` (boolean)
Returns whether or not the connection is currently writable. During normal operation
this should be true, however if the client is in the process of reconnecting,
this will be false.

## Event: `'connect'`

Emitted on successful connect to the STOMP server.

## Event: `'error'`

Emitted on an error at either the TCP or STOMP protocol layer. An Error object
will be passed. All error objects have a `.message` property, STOMP protocol
errors may also have a `.details` property.

If the error was caused by a failure to reconnect after exceeding the number of
reconnection attempts, the error object will have a `reconnectionFailed` property.

## Event: `'reconnect'`

Emitted when the client has successfully reconnected. The event arguments are
the new `sessionId` and the reconnection attempt number.

## Event: `'reconnecting'`

Emitted when the client has been disconnected for whatever reason, but is going
to attempt to reconnect.

## LICENSE

[MIT](LICENSE)
