/*
 * @moleculer/channels
 * Copyright (c) 2021 MoleculerJS (https://github.com/moleculerjs/channels)
 * MIT Licensed
 */

"use strict";

const BaseAdapter = require("./base");
const _ = require("lodash");
const { MoleculerError } = require("moleculer").Errors;

/**
 * @typedef {import('kafkajs').Kafka} KafkaClient Kafka Client
 * @typedef {import('kafkajs').Producer} KafkaProducer Kafka Producer
 * @typedef {import('kafkajs').Consumer} KafkaConsumer Kafka Consumer
 * @typedef {import('kafkajs').KafkaConfig} KafkaConfig Kafka configuration
 * @typedef {import('kafkajs').ProducerConfig} ProducerConfig Kafka producer configuration
 * @typedef {import('kafkajs').ProducerConfig} ConsumerConfig Kafka consumer configuration
 * @typedef {import("moleculer").ServiceBroker} ServiceBroker Moleculer Service Broker instance
 * @typedef {import("moleculer").LoggerInstance} Logger Logger instance
 * @typedef {import("../index").Channel} Channel Base channel definition
 * @typedef {import("./base").BaseDefaultOptions} BaseDefaultOptions Base adapter options
 */

/**
 * @typedef {Object} KafkaDefaultOptions AMQP Adapter configuration
 * @property {Number} maxInFlight Max-in-flight messages
 * @property {KafkaConfig} kafka Kafka config
 */

/**
 * @typedef {Object} SubscriptionEntry
 * @property {Channel & KafkaDefaultOptions} chan AMQP Channel
 * @property {String} consumerTag AMQP consumer tag. More info: https://www.rabbitmq.com/consumers.html#consumer-tags
 */

/** @type {KafkaClient} */
let Kafka;

/**
 * Kafka adapter
 *
 * TODO:
 * 	- [ ] implement infinite connecting at starting
 * 	- [ ] implement auto-reconnecting
 * 	- [ ] create consumers for every channel because no unsubscribe method
 * 	- [ ] manual acknowledge
 * 	- [ ] implement maxInFlight
 * 	- [ ] implement message retries
 * 	- [ ] implement dead-letter-topic
 * 	- [ ] add log creator
 *
 * @class KafkaAdapter
 * @extends {BaseAdapter}
 */
class KafkaAdapter extends BaseAdapter {
	/**
	 * Constructor of adapter
	 * @param  {KafkaDefaultOptions|String?} opts
	 */
	constructor(opts) {
		if (_.isString(opts)) {
			opts = {
				kafka: {
					brokers: [opts.replace("kafka://", "")]
				}
			};
		}

		super(opts);

		/** @type {KafkaDefaultOptions & BaseDefaultOptions} */
		this.opts = _.defaultsDeep(this.opts, {
			maxInFlight: 1, // TODO
			kafka: {
				clientId: null, // set to nodeID in `init`
				brokers: ["localhost:9092"]
			}
		});

		/** @type {KafkaClient} */
		this.client = null;

		/** @type {KafkaProducer} */
		this.producer = null;

		/** @type {KafkaConsumer} */
		this.consumer = null;

		this.connected = false;
		this.stopping = false;
	}

	/**
	 * Initialize the adapter.
	 *
	 * @param {ServiceBroker} broker
	 * @param {Logger} logger
	 */
	init(broker, logger) {
		super.init(broker, logger);

		try {
			Kafka = require("kafkajs").Kafka;
		} catch (err) {
			/* istanbul ignore next */
			this.broker.fatal(
				"The 'kafkajs' package is missing! Please install it with 'npm install kafkajs --save' command.",
				err,
				true
			);
		}

		this.checkClientLibVersion("kafkajs", "^1.15.0");

		this.opts.kafka.clientId = this.broker.nodeID;
	}

	/**
	 * Connect to the adapter with reconnecting logic
	 */
	async connect() {
		this.logger.debug("Connecting to Kafka brokers...", this.opts.kafka.brokers);

		this.client = new Kafka(this.opts.kafka);

		this.producer = this.client.producer(/*TODO: */);
		this.consumer = this.client.consumer({ groupId: this.broker.nodeID /*TODO: */ });

		await this.producer.connect();
		await this.consumer.connect();

		// TODO: subscribe to events (disconnect, error, ...)
		// https://kafka.js.org/docs/instrumentation-events

		this.logger.info("Kafka adapter is connected.");
	}

	/**
	 * Disconnect from adapter
	 */
	async disconnect() {
		if (this.stopping) return;

		this.stopping = true;
		try {
			this.logger.info("Closing Kafka connection...");
			if (this.producer) {
				await this.producer.disconnect();
				this.producer = null;
			}
			if (this.consumer) {
				await this.consumer.disconnect();
				this.consumer = null;
			}
		} catch (err) {
			this.logger.error("Error while closing Kafka connection.", err);
		}
		this.stopping = false;
	}

	/**
	 * Subscribe to a channel.
	 *
	 * @param {Channel & AmqpDefaultOptions} chan
	 */
	async subscribe(chan) {
		this.logger.debug(
			`Subscribing to '${chan.name}' chan with '${chan.group}' group...'`,
			chan.id
		);
		/*
		try {
			if (chan.maxRetries == null) chan.maxRetries = this.opts.maxRetries;
			chan.deadLettering = _.defaultsDeep({}, chan.deadLettering, this.opts.deadLettering);
			if (chan.deadLettering.enabled) {
				chan.deadLettering.queueName = this.addPrefixTopic(chan.deadLettering.queueName);
				chan.deadLettering.exchangeName = this.addPrefixTopic(
					chan.deadLettering.exchangeName
				);
			}

			// --- CREATE EXCHANGE ---
			// More info: http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertExchange
			const exchangeOptions = _.defaultsDeep(
				{},
				chan.amqp ? chan.amqp.exchangeOptions : {},
				this.opts.amqp.exchangeOptions
			);
			this.logger.debug(`Asserting '${chan.name}' fanout exchange...`, exchangeOptions);
			this.channel.assertExchange(chan.name, "fanout", exchangeOptions);

			// --- CREATE QUEUE ---
			const queueName = `${chan.group}.${chan.name}`;

			// More info: http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertQueue
			const queueOptions = _.defaultsDeep(
				{},
				chan.amqp ? chan.amqp.queueOptions : {},
				this.opts.amqp.queueOptions
			);
			this.logger.debug(`Asserting '${queueName}' queue...`, queueOptions);
			await this.channel.assertQueue(queueName, queueOptions);

			// --- BIND QUEUE TO EXCHANGE ---
			this.logger.debug(`Binding '${chan.name}' -> '${queueName}'...`);
			this.channel.bindQueue(queueName, chan.name, "");

			// More info http://www.squaremobius.net/amqp.node/channel_api.html#channel_consume
			const consumeOptions = _.defaultsDeep(
				{},
				chan.amqp ? chan.amqp.consumeOptions : {},
				this.opts.amqp.consumeOptions
			);

			this.initChannelActiveMessages(chan.id);
			this.logger.debug(`Consuming '${queueName}' queue...`, consumeOptions);
			const res = await this.channel.consume(
				queueName,
				this.createConsumerHandler(chan),
				consumeOptions
			);

			this.subscriptions.set(chan.id, { chan, consumerTag: res.consumerTag });
		} catch (err) {
			this.logger.error(
				`Error while subscribing to '${chan.name}' chan with '${chan.group}' group`,
				err
			);
			throw err;
		}*/
	}

	/**
	 * Create a handler for the consumer.
	 *
	 * @param {Channel & AmqpDefaultOptions} chan
	 * @returns {Function}
	 */
	/*createConsumerHandler(chan) {
		return async msg => {
			this.logger.debug(`AMQP message received in '${chan.name}' queue.`);
			const id =
				msg.properties.correlationId ||
				`${msg.fields.consumerTag}:${msg.fields.deliveryTag}`;

			try {
				this.addChannelActiveMessages(chan.id, [id]);
				const content = this.serializer.deserialize(msg.content);
				//this.logger.debug("Content:", content);

				await chan.handler(content, msg);
				this.channel.ack(msg);

				this.removeChannelActiveMessages(chan.id, [id]);
			} catch (err) {
				this.removeChannelActiveMessages(chan.id, [id]);

				this.logger.warn(`AMQP message processing error in '${chan.name}' queue.`, err);
				if (!chan.maxRetries) {
					if (chan.deadLettering.enabled) {
						// Reached max retries and has dead-letter topic, move message
						this.logger.debug(
							`No retries, moving message to '${chan.deadLettering.queueName}' queue...`
						);
						await this.moveToDeadLetter(chan, msg);
					} else {
						// No retries, drop message
						this.logger.error(`No retries, drop message...`);
						this.channel.nack(msg, false, false);
					}
					return;
				}

				const redeliveryCount = msg.properties.headers["x-redelivered-count"] || 1;
				if (chan.maxRetries > 0 && redeliveryCount >= chan.maxRetries) {
					if (chan.deadLettering.enabled) {
						// Reached max retries and has dead-letter topic, move message
						this.logger.debug(
							`Message redelivered too many times (${redeliveryCount}). Moving message to '${chan.deadLettering.queueName}' queue...`
						);
						await this.moveToDeadLetter(chan, msg);
					} else {
						// Reached max retries and no dead-letter topic, drop message
						this.logger.error(
							`Message redelivered too many times (${redeliveryCount}). Drop message...`
						);
						this.channel.nack(msg, false, false);
					}
				} else {
					// Redeliver the message directly to the queue instead of exchange
					const queueName = `${chan.group}.${chan.name}`;
					this.logger.warn(
						`Redeliver message into '${queueName}' queue.`,
						redeliveryCount
					);

					const res = this.channel.publish("", queueName, msg.content, {
						headers: Object.assign({}, msg.properties.headers, {
							"x-redelivered-count": redeliveryCount + 1
						})
					});
					if (res === false)
						throw new MoleculerError("AMQP publish error. Write buffer is full.");

					this.channel.ack(msg);
				}
			}
		};
	}*/

	/*
	async moveToDeadLetter(chan, msg) {
		const res = this.channel.publish(
			chan.deadLettering.exchangeName || "",
			chan.deadLettering.queueName,
			msg.content,
			{
				headers: {
					"x-original-channel": chan.name
				}
			}
		);
		if (res === false) throw new MoleculerError("AMQP publish error. Write buffer is full.");

		this.channel.ack(msg);
	}
*/
	/**
	 * Unsubscribe from a channel.
	 *
	 * @param {Channel & AmqpDefaultOptions} chan
	 */
	async unsubscribe(chan) {
		/*this.logger.debug(`Unsubscribing from '${chan.name}' chan with '${chan.group}' group...'`);

		const sub = this.subscriptions.get(chan.id);
		if (!sub) return;

		await this.channel.cancel(sub.consumerTag);

		await new Promise((resolve, reject) => {
			const checkPendingMessages = () => {
				try {
					if (this.getNumberOfChannelActiveMessages(chan.id) === 0) {
						this.logger.debug(
							`Unsubscribing from '${chan.name}' chan with '${chan.group}' group...'`
						);

						// Stop tracking channel's active messages
						this.stopChannelActiveMessages(chan.id);

						resolve();
					} else {
						this.logger.warn(
							`Processing ${this.getNumberOfChannelActiveMessages(
								chan.id
							)} message(s) of '${chan.id}'...`
						);

						setTimeout(() => checkPendingMessages(), 1000);
					}
				} catch (err) {
					reject(err);
				}
			};

			checkPendingMessages();
		});*/
	}

	/**
	 * Resubscribe to all channels.
	 * @returns {Promise<void>
	 */
	async resubscribeAllChannels() {
		/*
		this.logger.info("Resubscribing to all channels...");
		for (const { chan } of Array.from(this.subscriptions.values())) {
			await this.subscribe(chan);
		}
		*/
	}

	/**
	 * Publish a payload to a channel.
	 *
	 * @param {String} channelName
	 * @param {any} payload
	 * @param {Object?} opts
	 * @param {Boolean?} opts.raw
	 * @param {Buffer?|string?} opts.key
	 * @param {Number?} opts.partition
	 * @param {Object?} opts.headers
	 */
	async publish(channelName, payload, opts = {}) {
		// Adapter is stopping. Publishing no longer is allowed
		if (this.stopping) return;

		this.logger.debug(`Publish a message to '${channelName}' topic...`, payload, opts);

		const data = opts.raw ? payload : this.serializer.serialize(payload);
		const res = await this.producer.send({
			topic: channelName,
			messages: [{ key: opts.key, value: data, partition: opts.partition }],
			acks: opts.acks,
			timeout: opts.timeout,
			compression: opts.compression
		});

		this.logger.debug(`Message was published at '${channelName}'`, res);
	}
}

module.exports = KafkaAdapter;
