/*
 * @moleculer/channels
 * Copyright (c) 2021 MoleculerJS (https://github.com/moleculerjs/channels)
 * MIT Licensed
 */

"use strict";

const BaseAdapter = require("./base");
const _ = require("lodash");
const { MoleculerError } = require("moleculer").Errors;

let Amqplib;

/**
 * Type defs to add some IntelliSense
 * @typedef {import("moleculer").ServiceBroker} ServiceBroker
 * @typedef {import("moleculer").LoggerInstance} Logger
 * @typedef {import("../index").Channel} Channel
 * @typedef {import("./base").BaseDefaultOptions} BaseDefaultOptions
 */

/**
 * @typedef {Object} AmqpDefaultOptions Redis Adapter configuration
 * @property {Object} amqp AMQP lib configuration
 * @property {Number} amqp.url Connection URI
 * @property {Number} amqp.prefetch Max-in-flight messages
 * @property {Object} amqp.socketOptions AMQP lib socket configuration
 * @property {Object} amqp.queueOptions AMQP lib queue configuration
 * @property {Object} amqp.exchangeOptions AMQP lib exchange configuration
 * @property {Object} amqp.messageOptions AMQP lib message configuration
 * @property {Object} amqp.consumeOptions AMQP lib consume configuration
 */

/**
 * AMQP adapter for RabbitMQ
 *
 * TODO: rewrite to using RabbitMQ Streams
 * https://www.rabbitmq.com/streams.html
 *
 * @class AmqpAdapter
 * @extends {BaseAdapter}
 */
class AmqpAdapter extends BaseAdapter {
	/**
	 * Constructor of adapter
	 * @param  {Object?} opts
	 */
	constructor(opts) {
		if (_.isString(opts)) {
			opts = {
				amqp: {
					url: opts
				}
			};
		}

		super(opts);

		/** @type {AmqpDefaultOptions & BaseDefaultOptions} */
		this.opts = _.defaultsDeep(this.opts, {
			amqp: {
				prefetch: 10,
				socketOptions: {},
				queueOptions: {},
				exchangeOptions: {},
				messageOptions: {},
				consumeOptions: {}
			}
		});

		if (typeof this.opts.amqp.url == "string") {
			this.opts.amqp.url = this.opts.amqp.url
				.split(";")
				.filter(s => !!s)
				.map(s => s.trim());
		}

		this.connection = null;
		this.channel = null;

		this.subscriptions = new Map();
		this.connected = false;
		this.stopping = false;
		this.connectAttempt = 0;
		this.connectionCount = 0; // To detect reconnections
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
			Amqplib = require("amqplib");
		} catch (err) {
			/* istanbul ignore next */
			this.broker.fatal(
				"The 'amqplib' package is missing! Please install it with 'npm install amqplib --save' command.",
				err,
				true
			);
		}

		this.checkClientLibVersion("amqplib", "^0.8.0");
	}

	/**
	 * Connect to the adapter with reconnecting logic
	 */
	connect() {
		return new Promise(resolve => {
			const doConnect = () => {
				this.tryConnect()
					.then(resolve)
					.catch(err => {
						this.logger.error("Unable to connect AMQP server.", err);
						setTimeout(() => {
							this.logger.info("Reconnecting...");
							doConnect();
						}, 2000);
					});
			};

			doConnect();
		});
	}

	/**
	 * Trying connect to the adapter.
	 */
	async tryConnect() {
		let uri = this.opts.amqp.url;
		if (Array.isArray(uri)) {
			this.connectAttempt = (this.connectAttempt || 0) + 1;
			const urlIndex = (this.connectAttempt - 1) % uri.length;
			uri = uri[urlIndex];
		}

		this.logger.debug("Connecting to AMQP server...", uri);
		this.connection = await Amqplib.connect(uri, this.opts.amqp.socketOptions);
		this.connected = true;

		this.connection
			.on("error", err => {
				// No need to reject here since close event will be fired after
				// if not connected at all connection promise will be rejected
				this.logger.error("AMQP connection error.", err);
			})
			.on("close", err => {
				this.connected = false;
				if (!this.stopping) {
					this.logger.error("AMQP connection is closed.", err);
					setTimeout(() => {
						this.logger.info("Reconnecting...");
						this.connect();
					}, 2000);
				} else {
					this.logger.info("AMQP connection is closed gracefully.");
				}
			})
			.on("blocked", reason => {
				this.logger.warn("AMQP connection is blocked.", reason);
			})
			.on("unblocked", () => {
				this.logger.info("AMQP connection is unblocked.");
			});
		this.logger.info("AMQP is connected.");

		this.logger.debug(`Creating AMQP channel...`);
		this.channel = await this.connection.createChannel();
		this.channel
			.on("close", () => {
				if (!this.stopping) {
					this.logger.error("AMQP channel closed.");
				}
			})
			.on("error", err => {
				this.logger.error("AMQP channel error", err);
			})
			.on("drain", () => {
				this.logger.info("AMQP channel is drained.");
			})
			.on("return", msg => {
				this.logger.warn("AMQP channel returned a message.", msg);
			});

		if (this.opts.amqp.prefetch != null) {
			this.channel.prefetch(this.opts.amqp.prefetch);
		}

		this.logger.info("AMQP channel created.");
		this.connectionCount++;

		const isReconnect = this.connectionCount > 1;
		if (isReconnect) {
			await this.resubscribeAllChannels();
		}
	}

	/**
	 * Disconnect from adapter
	 */
	async disconnect() {
		if (this.stopping) return;

		this.stopping = true;
		try {
			if (this.connection) {
				this.logger.info("Closing AMQP connection...");
				await this.connection.close();
				this.connection = null;
				this.channel = null;
			}
		} catch (err) {
			this.logger.error("Error while closing AMQP connection.", err);
		}
		this.stopping = false;
	}

	/**
	 * Subscribe to a channel.
	 *
	 * @param {Channel} chan
	 */
	async subscribe(chan) {
		this.logger.debug(
			`Subscribing to '${chan.name}' chan with '${chan.group}' group...'`,
			chan.id
		);

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
		}
	}

	/**
	 * Create a handler for the consumer.
	 *
	 * @param {Channel} chan
	 * @returns {Function}
	 */
	createConsumerHandler(chan) {
		return async msg => {
			this.logger.debug(`AMQP message received in '${chan.name}' queue.`);
			const id =
				msg.properties.correlationId ||
				`${msg.fields.consumerTag}:${msg.fields.deliveryTag}`;

			try {
				this.addChannelActiveMessages(chan.id, [id]);
				const content = this.serializer.deserialize(msg.content);
				//this.logger.debug("Content:", content);

				await chan.handler(content);
				this.channel.ack(msg);

				this.removeChannelActiveMessages(chan.id, [id]);
			} catch (err) {
				this.removeChannelActiveMessages(chan.id, [id]);

				this.logger.warn(`AMQP message processing error in '${chan.name}' queue.`, err);
				if (!chan.maxRetries) {
					// No retries, drop message
					this.logger.error(`Drop message...`);
					this.channel.nack(msg, false, false);
				}

				const redeliveryCount = msg.properties.headers["x-redelivered-count"] || 1;
				if (chan.maxRetries > 0 && redeliveryCount >= chan.maxRetries) {
					if (chan.deadLettering.enabled) {
						// Reached max retries and has dead-letter topic, move message
						this.logger.debug(
							`Message redelivered too many times (${redeliveryCount}). Moving a message to '${chan.deadLettering.queueName}' queue...`
						);
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
						if (res === false)
							throw new MoleculerError("AMQP publish error. Write buffer is full.");

						this.channel.ack(msg);
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
	}

	/**
	 * Unsubscribe from a channel.
	 *
	 * @param {Channel} chan
	 */
	async unsubscribe(chan) {
		this.logger.debug(`Unsubscribing from '${chan.name}' chan with '${chan.group}' group...'`);

		const { consumerTag } = this.subscriptions.get(chan.id);
		await this.channel.cancel(consumerTag);

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
		});
	}

	/**
	 * Resubscribe to all channels.
	 * @returns {Promise<void>
	 */
	async resubscribeAllChannels() {
		this.logger.info("Resubscribing to all channels...");
		for (const { chan } of Array.from(this.subscriptions.values())) {
			await this.subscribe(chan);
		}
	}

	/**
	 * Publish a payload to a channel.
	 *
	 * @param {String} channelName
	 * @param {any} payload
	 * @param {Object?} opts
	 */
	async publish(channelName, payload, opts = {}) {
		// Adapter is stopping. Publishing no longer is allowed
		if (this.stopping) return;

		// Available options: http://www.squaremobius.net/amqp.node/channel_api.html#channel_publish
		const messageOptions = _.defaultsDeep(
			{},
			{
				persistent: opts.persistent,
				expiration: opts.ttl,
				priority: opts.priority,
				correlationId: opts.correlationId,
				headers: opts.headers
				// ? mandatory: opts.mandatory
			},
			this.opts.amqp.messageOptions
		);

		this.logger.debug(`Publish a message to '${channelName}' channel...`, payload, opts);

		const data = opts.raw ? payload : this.serializer.serialize(payload);
		const res = this.channel.publish(channelName, "", data, messageOptions);
		if (res === false) throw new MoleculerError("AMQP publish error. Write buffer is full.");
		this.logger.debug(`Message was published at '${channelName}'`);
	}
}

module.exports = AmqpAdapter;