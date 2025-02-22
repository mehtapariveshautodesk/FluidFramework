/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import * as os from "os";
import cluster from "cluster";
import { TypedEventEmitter } from "@fluidframework/common-utils";
import { ICollaborationSessionEvents } from "@fluidframework/server-lambdas";
import { KafkaOrdererFactory } from "@fluidframework/server-kafka-orderer";
import {
	LocalNodeFactory,
	LocalOrderManager,
	NodeManager,
	ReservationManager,
} from "@fluidframework/server-memory-orderer";
import * as services from "@fluidframework/server-services";
import * as core from "@fluidframework/server-services-core";
import { getLumberBaseProperties, Lumberjack } from "@fluidframework/server-services-telemetry";
import * as utils from "@fluidframework/server-services-utils";
import * as bytes from "bytes";
import { Provider } from "nconf";
import * as Redis from "ioredis";
import * as winston from "winston";
import * as ws from "ws";
import { NexusRunner } from "./runner";
import { StorageNameAllocator } from "./services";
import { INexusResourcesCustomizations } from ".";

class NodeWebSocketServer implements core.IWebSocketServer {
	private readonly webSocketServer: ws.Server;

	constructor(portNumber: number) {
		this.webSocketServer = new ws.Server({ port: portNumber });
	}
	public on(event: string, listener: (...args: any[]) => void) {
		this.webSocketServer.on(event, listener);
	}
	// eslint-disable-next-line @typescript-eslint/promise-function-async
	public close(): Promise<void> {
		this.webSocketServer.close();
		return Promise.resolve();
	}
}

/**
 * @internal
 */
export class OrdererManager implements core.IOrdererManager {
	constructor(
		private readonly globalDbEnabled: boolean,
		private readonly ordererUrl: string,
		private readonly tenantManager: core.ITenantManager,
		private readonly localOrderManager: LocalOrderManager,
		private readonly kafkaFactory: KafkaOrdererFactory,
	) {}

	public async getOrderer(tenantId: string, documentId: string): Promise<core.IOrderer> {
		const tenant = await this.tenantManager.getTenant(tenantId, documentId);

		const messageMetaData = { documentId, tenantId };
		winston.info(`tenant orderer: ${JSON.stringify(tenant.orderer)}`, { messageMetaData });
		Lumberjack.info(
			`tenant orderer: ${JSON.stringify(tenant.orderer)}`,
			getLumberBaseProperties(documentId, tenantId),
		);

		if (tenant.orderer.url !== this.ordererUrl && !this.globalDbEnabled) {
			Lumberjack.error(`Invalid ordering service endpoint`, { messageMetaData });
			throw new Error("Invalid ordering service endpoint");
		}

		switch (tenant.orderer.type) {
			case "kafka":
				return this.kafkaFactory.create(tenantId, documentId);
			default:
				return this.localOrderManager.get(tenantId, documentId);
		}
	}
}

/**
 * @internal
 */
export class NexusResources implements core.IResources {
	public webServerFactory: core.IWebServerFactory;

	constructor(
		public config: Provider,
		public redisConfig: any,
		public clientManager: core.IClientManager,
		public webSocketLibrary: string,
		public orderManager: core.IOrdererManager,
		public tenantManager: core.ITenantManager,
		public socketConnectTenantThrottler: core.IThrottler,
		public socketConnectClusterThrottler: core.IThrottler,
		public socketSubmitOpThrottler: core.IThrottler,
		public socketSubmitSignalThrottler: core.IThrottler,
		public singleUseTokenCache: core.ICache,
		public storage: core.IDocumentStorage,
		public mongoManager: core.MongoManager,
		public port: any,
		public documentsCollectionName: string,
		public metricClientConfig: any,
		public throttleAndUsageStorageManager?: core.IThrottleAndUsageStorageManager,
		public verifyMaxMessageSize?: boolean,
		public redisCache?: core.ICache,
		public socketTracker?: core.IWebSocketTracker,
		public tokenRevocationManager?: core.ITokenRevocationManager,
		public revokedTokenChecker?: core.IRevokedTokenChecker,
		public collaborationSessionEvents?: TypedEventEmitter<ICollaborationSessionEvents>,
		public serviceMessageResourceManager?: core.IServiceMessageResourceManager,
		public clusterDrainingChecker?: core.IClusterDrainingChecker,
	) {
		const socketIoAdapterConfig = config.get("nexus:socketIoAdapter");
		const httpServerConfig: services.IHttpServerConfig = config.get("system:httpServer");
		const socketIoConfig = config.get("nexus:socketIo");
		const nodeClusterConfig: Partial<services.INodeClusterConfig> | undefined =
			config.get("nexus:nodeClusterConfig");
		const useNodeCluster = config.get("nexus:useNodeCluster");
		this.webServerFactory = useNodeCluster
			? new services.SocketIoNodeClusterWebServerFactory(
					redisConfig,
					socketIoAdapterConfig,
					httpServerConfig,
					socketIoConfig,
					nodeClusterConfig,
			  )
			: new services.SocketIoWebServerFactory(
					this.redisConfig,
					socketIoAdapterConfig,
					httpServerConfig,
					socketIoConfig,
			  );
	}

	public async dispose(): Promise<void> {
		const mongoClosedP = this.mongoManager.close();
		const tokenRevocationManagerP = this.tokenRevocationManager
			? this.tokenRevocationManager.close()
			: Promise.resolve();
		const serviceMessageManagerP = this.serviceMessageResourceManager
			? this.serviceMessageResourceManager.close()
			: Promise.resolve();
		await Promise.all([mongoClosedP, tokenRevocationManagerP, serviceMessageManagerP]);
	}
}

/**
 * @internal
 */
export class NexusResourcesFactory implements core.IResourcesFactory<NexusResources> {
	public async create(
		config: Provider,
		customizations?: INexusResourcesCustomizations,
	): Promise<NexusResources> {
		const metricClientConfig = config.get("metric");
		// Producer used to publish messages
		const kafkaEndpoint = config.get("kafka:lib:endpoint");
		const kafkaLibrary = config.get("kafka:lib:name");
		const kafkaClientId = config.get("nexus:kafkaClientId");
		const topic = config.get("nexus:topic");
		const kafkaProducerPollIntervalMs = config.get("kafka:lib:producerPollIntervalMs");
		const kafkaNumberOfPartitions = config.get("kafka:lib:numberOfPartitions");
		const kafkaReplicationFactor = config.get("kafka:lib:replicationFactor");
		const kafkaMaxBatchSize = config.get("kafka:lib:maxBatchSize");
		const kafkaSslCACertFilePath: string = config.get("kafka:lib:sslCACertFilePath");
		const eventHubConnString: string = config.get("kafka:lib:eventHubConnString");

		const producer = services.createProducer(
			kafkaLibrary,
			kafkaEndpoint,
			kafkaClientId,
			topic,
			false,
			kafkaProducerPollIntervalMs,
			kafkaNumberOfPartitions,
			kafkaReplicationFactor,
			kafkaMaxBatchSize,
			kafkaSslCACertFilePath,
			eventHubConnString,
		);

		const redisConfig = config.get("redis");

		// Redis connection for client manager and single-use JWTs.
		const redisConfig2 = config.get("redis2");
		const redisOptions2: Redis.RedisOptions = {
			host: redisConfig2.host,
			port: redisConfig2.port,
			password: redisConfig2.pass,
			connectTimeout: redisConfig2.connectTimeout,
			enableReadyCheck: true,
			maxRetriesPerRequest: redisConfig2.maxRetriesPerRequest,
			enableOfflineQueue: redisConfig2.enableOfflineQueue,
			retryStrategy: utils.getRedisClusterRetryStrategy({
				delayPerAttemptMs: 50,
				maxDelayMs: 2000,
			}),
		};
		if (redisConfig2.enableAutoPipelining) {
			/**
			 * When enabled, all commands issued during an event loop iteration are automatically wrapped in a
			 * pipeline and sent to the server at the same time. This can improve performance by 30-50%.
			 * More info: https://github.com/luin/ioredis#autopipelining
			 */
			redisOptions2.enableAutoPipelining = true;
			redisOptions2.autoPipeliningIgnoredCommands = ["ping"];
		}
		if (redisConfig2.tls) {
			redisOptions2.tls = {
				servername: redisConfig2.host,
			};
		}

		const redisParams2 = {
			expireAfterSeconds: redisConfig2.keyExpireAfterSeconds as number | undefined,
		};

		const redisClient: Redis.default | Redis.Cluster = utils.getRedisClient(
			redisOptions2,
			redisConfig2.slotsRefreshTimeout,
			redisConfig2.enableClustering,
		);
		const clientManager = new services.ClientManager(redisClient, redisParams2);

		const redisClientForJwtCache: Redis.default | Redis.Cluster = utils.getRedisClient(
			redisOptions2,
			redisConfig2.slotsRefreshTimeout,
			redisConfig2.enableClustering,
		);

		const redisJwtCache = new services.RedisCache(redisClientForJwtCache);

		// Database connection for global db if enabled
		let globalDbMongoManager;
		const globalDbEnabled = config.get("mongo:globalDbEnabled") as boolean;
		const factory = await services.getDbFactory(config);
		if (globalDbEnabled) {
			globalDbMongoManager = new core.MongoManager(factory, false, null, true);
		}

		// Database connection for operations db
		const operationsDbMongoManager = new core.MongoManager(factory);
		const documentsCollectionName = config.get("mongo:collectionNames:documents");
		const checkpointsCollectionName = config.get("mongo:collectionNames:checkpoints");

		// Create the index on the documents collection
		const dbManager = globalDbEnabled ? globalDbMongoManager : operationsDbMongoManager;
		const db: core.IDb = await dbManager.getDatabase();
		const documentsCollection = db.collection<core.IDocument>(documentsCollectionName);
		await documentsCollection.createIndex(
			{
				documentId: 1,
				tenantId: 1,
			},
			true,
		);
		const deltasCollectionName = config.get("mongo:collectionNames:deltas");
		const scribeCollectionName = config.get("mongo:collectionNames:scribeDeltas");

		// Setup for checkpoint collection
		const localCheckpointEnabled = config.get("checkpoints:localCheckpointEnabled");
		const operationsDb = await operationsDbMongoManager.getDatabase();
		const checkpointsCollection =
			operationsDb.collection<core.ICheckpoint>(checkpointsCollectionName);
		await checkpointsCollection.createIndex(
			{
				documentId: 1,
			},
			true,
		);
		await checkpointsCollection.createIndex(
			{
				tenantId: 1,
			},
			false,
		);

		const defaultTTLInSeconds = 864000;
		const checkpointsTTLSeconds =
			config.get("checkpoints:checkpointsTTLInSeconds") ?? defaultTTLInSeconds;
		await checkpointsCollection.createTTLIndex({ _ts: 1 }, checkpointsTTLSeconds);

		const nodeCollectionName = config.get("mongo:collectionNames:nodes");
		const nodeManager = new NodeManager(operationsDbMongoManager, nodeCollectionName);
		// This.nodeTracker.on("invalidate", (id) => this.emit("invalidate", id));
		const reservationManager = new ReservationManager(
			nodeManager,
			operationsDbMongoManager,
			config.get("mongo:collectionNames:reservations"),
		);

		const internalHistorianUrl = config.get("worker:internalBlobStorageUrl");
		const authEndpoint = config.get("auth:endpoint");
		const tenantManager = new services.TenantManager(authEndpoint, internalHistorianUrl);

		// Redis connection for throttling.
		const redisConfigForThrottling = config.get("redisForThrottling");
		const redisOptionsForThrottling: Redis.RedisOptions = {
			host: redisConfigForThrottling.host,
			port: redisConfigForThrottling.port,
			password: redisConfigForThrottling.pass,
			connectTimeout: redisConfigForThrottling.connectTimeout,
			enableReadyCheck: true,
			maxRetriesPerRequest: redisConfigForThrottling.maxRetriesPerRequest,
			enableOfflineQueue: redisConfigForThrottling.enableOfflineQueue,
			retryStrategy: utils.getRedisClusterRetryStrategy({
				delayPerAttemptMs: 50,
				maxDelayMs: 2000,
			}),
		};
		if (redisConfigForThrottling.enableAutoPipelining) {
			/**
			 * When enabled, all commands issued during an event loop iteration are automatically wrapped in a
			 * pipeline and sent to the server at the same time. This can improve performance by 30-50%.
			 * More info: https://github.com/luin/ioredis#autopipelining
			 */
			redisOptionsForThrottling.enableAutoPipelining = true;
			redisOptionsForThrottling.autoPipeliningIgnoredCommands = ["ping"];
		}
		if (redisConfigForThrottling.tls) {
			redisOptionsForThrottling.tls = {
				servername: redisConfigForThrottling.host,
			};
		}
		const redisParamsForThrottling = {
			expireAfterSeconds: redisConfigForThrottling.keyExpireAfterSeconds as
				| number
				| undefined,
		};

		const redisClientForThrottling: Redis.default | Redis.Cluster = utils.getRedisClient(
			redisOptionsForThrottling,
			redisConfigForThrottling.slotsRefreshTimeout,
			redisConfigForThrottling.enableClustering,
		);
		const redisThrottleAndUsageStorageManager =
			new services.RedisThrottleAndUsageStorageManager(
				redisClientForThrottling,
				redisParamsForThrottling,
			);

		const configureThrottler = (
			throttleConfig: Partial<utils.IThrottleConfig>,
		): core.IThrottler => {
			const throttlerHelper = new services.ThrottlerHelper(
				redisThrottleAndUsageStorageManager,
				throttleConfig.maxPerMs,
				throttleConfig.maxBurst,
				throttleConfig.minCooldownIntervalInMs,
			);
			return new services.Throttler(
				throttlerHelper,
				throttleConfig.minThrottleIntervalInMs,
				winston,
				throttleConfig.maxInMemoryCacheSize,
				throttleConfig.maxInMemoryCacheAgeInMs,
				throttleConfig.enableEnhancedTelemetry,
			);
		};

		// Socket Connection Throttler
		const socketConnectionThrottleConfigPerTenant = utils.getThrottleConfig(
			config.get("nexus:throttling:socketConnectionsPerTenant"),
		);
		const socketConnectTenantThrottler = configureThrottler(
			socketConnectionThrottleConfigPerTenant,
		);

		const socketConnectionThrottleConfigPerCluster = utils.getThrottleConfig(
			config.get("nexus:throttling:socketConnectionsPerCluster"),
		);
		const socketConnectClusterThrottler = configureThrottler(
			socketConnectionThrottleConfigPerCluster,
		);

		// Socket SubmitOp Throttler
		const submitOpThrottleConfig = utils.getThrottleConfig(
			config.get("nexus:throttling:submitOps"),
		);
		const socketSubmitOpThrottler = configureThrottler(submitOpThrottleConfig);

		// Socket SubmitSignal Throttler
		const submitSignalThrottleConfig = utils.getThrottleConfig(
			config.get("nexus:throttling:submitSignals"),
		);
		const socketSubmitSignalThrottler = configureThrottler(submitSignalThrottleConfig);
		const documentRepository =
			customizations?.documentRepository ??
			new core.MongoDocumentRepository(documentsCollection);
		const deliCheckpointRepository = new core.MongoCheckpointRepository(
			checkpointsCollection,
			"deli",
		);
		const scribeCheckpointRepository = new core.MongoCheckpointRepository(
			checkpointsCollection,
			"scribe",
		);

		const deliCheckpointService = new core.CheckpointService(
			deliCheckpointRepository,
			documentRepository,
			localCheckpointEnabled,
		);
		const scribeCheckpointService = new core.CheckpointService(
			scribeCheckpointRepository,
			documentRepository,
			localCheckpointEnabled,
		);

		const databaseManager = new core.MongoDatabaseManager(
			globalDbEnabled,
			operationsDbMongoManager,
			globalDbMongoManager,
			nodeCollectionName,
			documentsCollectionName,
			checkpointsCollectionName,
			deltasCollectionName,
			scribeCollectionName,
		);

		const enableWholeSummaryUpload = config.get("storage:enableWholeSummaryUpload") as boolean;
		const opsCollection = await databaseManager.getDeltaCollection(undefined, undefined);
		const storagePerDocEnabled = (config.get("storage:perDocEnabled") as boolean) ?? false;
		const storageNameAllocator = storagePerDocEnabled
			? customizations?.storageNameAllocator ?? new StorageNameAllocator(tenantManager)
			: undefined;
		const storage = new services.DocumentStorage(
			documentRepository,
			tenantManager,
			enableWholeSummaryUpload,
			opsCollection,
			storageNameAllocator,
		);

		const maxSendMessageSize = bytes.parse(config.get("nexus:maxMessageSize"));
		// Disable by default because microsoft/FluidFramework/pull/#9223 set chunking to disabled by default.
		// Therefore, default clients will ignore server's 16kb message size limit.
		const verifyMaxMessageSize = config.get("nexus:verifyMaxMessageSize") ?? false;

		// This cache will be used to store connection counts for logging connectionCount metrics.
		let redisCache: core.ICache;
		if (config.get("nexus:enableConnectionCountLogging")) {
			const redisOptions: Redis.RedisOptions = {
				host: redisConfig.host,
				port: redisConfig.port,
				password: redisConfig.pass,
				connectTimeout: redisConfig.connectTimeout,
				enableReadyCheck: true,
				maxRetriesPerRequest: redisConfig.maxRetriesPerRequest,
				enableOfflineQueue: redisConfig.enableOfflineQueue,
				retryStrategy: utils.getRedisClusterRetryStrategy({
					delayPerAttemptMs: 50,
					maxDelayMs: 2000,
				}),
			};
			if (redisConfig.enableAutoPipelining) {
				/**
				 * When enabled, all commands issued during an event loop iteration are automatically wrapped in a
				 * pipeline and sent to the server at the same time. This can improve performance by 30-50%.
				 * More info: https://github.com/luin/ioredis#autopipelining
				 */
				redisOptions.enableAutoPipelining = true;
				redisOptions.autoPipeliningIgnoredCommands = ["ping"];
			}
			if (redisConfig.tls) {
				redisOptions.tls = {
					servername: redisConfig.host,
				};
			}

			const redisClientForLogging: Redis.default | Redis.Cluster = utils.getRedisClient(
				redisOptions,
				redisConfig.slotsRefreshTimeout,
				redisConfig.enableClustering,
			);

			redisCache = new services.RedisCache(redisClientForLogging);
		}

		const address = `${await utils.getHostIp()}:4000`;
		const nodeFactory = new LocalNodeFactory(
			os.hostname(),
			address,
			storage,
			databaseManager,
			documentRepository,
			deliCheckpointRepository,
			scribeCheckpointRepository,
			deliCheckpointService,
			scribeCheckpointService,
			60000,
			() => new NodeWebSocketServer(cluster.isPrimary ? 4000 : 0),
			maxSendMessageSize,
			winston,
		);

		const localOrderManager = new LocalOrderManager(nodeFactory, reservationManager);
		const kafkaOrdererFactory = new KafkaOrdererFactory(
			producer,
			maxSendMessageSize,
			core.DefaultServiceConfiguration,
		);
		const serverUrl = config.get("worker:serverUrl");

		const orderManager = new OrdererManager(
			globalDbEnabled,
			serverUrl,
			tenantManager,
			localOrderManager,
			kafkaOrdererFactory,
		);

		const collaborationSessionEvents = new TypedEventEmitter<ICollaborationSessionEvents>();

		// This wanst to create stuff
		const port = utils.normalizePort(process.env.PORT || "3000");

		// Service Message setup
		const serviceMessageResourceManager = customizations?.serviceMessageResourceManager;

		// Set up token revocation if enabled
		/**
		 * Always have a revoked token checker,
		 * just make sure it rejects existing revoked tokens even with the feature flag disabled
		 */
		const revokedTokenChecker: core.IRevokedTokenChecker =
			customizations?.revokedTokenChecker ?? new utils.DummyRevokedTokenChecker();
		const tokenRevocationEnabled: boolean = utils.getBooleanFromConfig(
			"tokenRevocation:enable",
			config,
		);
		let socketTracker: core.IWebSocketTracker | undefined;
		let tokenRevocationManager: core.ITokenRevocationManager | undefined;
		if (tokenRevocationEnabled) {
			socketTracker = customizations?.webSocketTracker ?? new utils.WebSocketTracker();
			tokenRevocationManager =
				customizations?.tokenRevocationManager ?? new utils.DummyTokenRevocationManager();
			await tokenRevocationManager.initialize().catch((error) => {
				// Do NOT crash the service if token revocation feature cannot be initialized properly.
				Lumberjack.error("Failed to initialize token revocation manager", undefined, error);
			});
		}

		const webSocketLibrary = config.get("nexus:webSocketLib");

		return new NexusResources(
			config,
			redisConfig,
			clientManager,
			webSocketLibrary,
			orderManager,
			tenantManager,
			socketConnectTenantThrottler,
			socketConnectClusterThrottler,
			socketSubmitOpThrottler,
			socketSubmitSignalThrottler,
			redisJwtCache,
			storage,
			operationsDbMongoManager,
			port,
			documentsCollectionName,
			metricClientConfig,
			redisThrottleAndUsageStorageManager,
			verifyMaxMessageSize,
			redisCache,
			socketTracker,
			tokenRevocationManager,
			revokedTokenChecker,
			collaborationSessionEvents,
			serviceMessageResourceManager,
			customizations?.clusterDrainingChecker,
		);
	}
}

/**
 * @internal
 */
export class NexusRunnerFactory implements core.IRunnerFactory<NexusResources> {
	public async create(resources: NexusResources): Promise<core.IRunner> {
		return new NexusRunner(
			resources.webServerFactory,
			resources.config,
			resources.port,
			resources.orderManager,
			resources.tenantManager,
			resources.socketConnectTenantThrottler,
			resources.socketConnectClusterThrottler,
			resources.socketSubmitOpThrottler,
			resources.socketSubmitSignalThrottler,
			resources.storage,
			resources.clientManager,
			resources.metricClientConfig,
			resources.throttleAndUsageStorageManager,
			resources.verifyMaxMessageSize,
			resources.redisCache,
			resources.socketTracker,
			resources.tokenRevocationManager,
			resources.revokedTokenChecker,
			resources.collaborationSessionEvents,
			resources.clusterDrainingChecker,
		);
	}
}
