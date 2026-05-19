import { promises as fs } from "node:fs";
import path from "node:path";
import { paths } from "../constants";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { getAllContainerStats } from "./docker";

export type ResourceMetricServiceType =
	| "application"
	| "compose"
	| "libsql"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "postgres"
	| "redis";

export type ResourceMetricService = {
	serviceId: string;
	type: ResourceMetricServiceType;
	appName: string;
	serverId?: string | null;
};

export type ResourceMetricSnapshot = {
	time: string;
	cpuPercent: number;
	memoryBytes: number;
	memoryLimitBytes: number;
	blockReadBytes: number;
	blockWriteBytes: number;
	networkRxBytes: number;
	networkTxBytes: number;
	containers: number;
};

export type ResourceMetricSummary = {
	current: ResourceMetricSnapshot | null;
	history: ResourceMetricSnapshot[];
};

type DockerStatsRow = {
	BlockIO?: string;
	CPUPerc?: string;
	ID?: string;
	MemUsage?: string;
	Name?: string;
	NetIO?: string;
};

type DockerContainerLabels = {
	id: string;
	name: string;
	swarmServiceName: string;
	composeProject: string;
	stackNamespace: string;
};

const HISTORY_LIMIT = 120;
const MIN_SAMPLE_INTERVAL_MS = 30_000;

const emptySnapshot = (): ResourceMetricSnapshot => ({
	time: new Date().toISOString(),
	cpuPercent: 0,
	memoryBytes: 0,
	memoryLimitBytes: 0,
	blockReadBytes: 0,
	blockWriteBytes: 0,
	networkRxBytes: 0,
	networkTxBytes: 0,
	containers: 0,
});

const parsePercent = (value?: string) => {
	const parsed = Number.parseFloat(value?.replace("%", "") ?? "0");
	return Number.isFinite(parsed) ? parsed : 0;
};

const parseBytes = (value?: string) => {
	if (!value) return 0;
	const normalized = value.trim().replace(",", ".").toLowerCase();
	const match = normalized.match(/^([0-9.]+)\s*([kmgtp]?i?b?)?$/);
	if (!match) return 0;

	const amount = Number.parseFloat(match[1] ?? "0");
	if (!Number.isFinite(amount)) return 0;

	const unit = match[2] || "b";
	const multipliers: Record<string, number> = {
		b: 1,
		kb: 1000,
		mb: 1000 ** 2,
		gb: 1000 ** 3,
		tb: 1000 ** 4,
		pb: 1000 ** 5,
		kib: 1024,
		mib: 1024 ** 2,
		gib: 1024 ** 3,
		tib: 1024 ** 4,
		pib: 1024 ** 5,
	};

	return amount * (multipliers[unit] ?? 1);
};

const parsePair = (value?: string) => {
	const [left, right] = value?.split("/") ?? [];
	return {
		left: parseBytes(left),
		right: parseBytes(right),
	};
};

const findStatsForContainer = (
	stats: DockerStatsRow[],
	containerId: string,
	containerName: string,
) =>
	stats.find((item) => {
		const id = item.ID ?? "";
		const name = item.Name ?? "";
		return (
			id === containerId ||
			containerId.startsWith(id) ||
			id.startsWith(containerId) ||
			name === containerName
		);
	});

const listContainerLabels = async (serverId?: string | null) => {
	const command =
		'docker ps --format \'{{.ID}}\\t{{.Names}}\\t{{.Label "com.docker.swarm.service.name"}}\\t{{.Label "com.docker.compose.project"}}\\t{{.Label "com.docker.stack.namespace"}}\'';
	const result = serverId
		? await execAsyncRemote(serverId, command)
		: await execAsync(command);

	if (!result.stdout.trim()) return [];

	return result.stdout
		.trim()
		.split("\n")
		.map((line) => {
			const [id, name, swarmServiceName, composeProject, stackNamespace] =
				line.split("\t");
			return {
				id: id ?? "",
				name: name ?? "",
				swarmServiceName: swarmServiceName ?? "",
				composeProject: composeProject ?? "",
				stackNamespace: stackNamespace ?? "",
			};
		});
};

const serviceOwnsContainer = (
	service: ResourceMetricService,
	container: DockerContainerLabels,
) => {
	if (service.type === "compose") {
		return (
			container.composeProject === service.appName ||
			container.stackNamespace === service.appName ||
			container.swarmServiceName.startsWith(`${service.appName}_`) ||
			container.name.startsWith(`${service.appName}-`) ||
			container.name.startsWith(`${service.appName}_`)
		);
	}

	return (
		container.swarmServiceName === service.appName ||
		container.name.startsWith(`${service.appName}.`)
	);
};

const aggregateRows = (rows: DockerStatsRow[]) => {
	const snapshot = emptySnapshot();
	snapshot.containers = rows.length;

	for (const row of rows) {
		const memory = parsePair(row.MemUsage);
		const block = parsePair(row.BlockIO);
		const network = parsePair(row.NetIO);

		snapshot.cpuPercent += parsePercent(row.CPUPerc);
		snapshot.memoryBytes += memory.left;
		snapshot.memoryLimitBytes += memory.right;
		snapshot.blockReadBytes += block.left;
		snapshot.blockWriteBytes += block.right;
		snapshot.networkRxBytes += network.left;
		snapshot.networkTxBytes += network.right;
	}

	return snapshot;
};

const historyPath = (scope: "project" | "service", id: string) => {
	const { MONITORING_PATH } = paths();
	return path.join(MONITORING_PATH, "resources", scope, `${id}.json`);
};

export const readResourceMetricHistory = async (
	scope: "project" | "service",
	id: string,
) => {
	try {
		const data = await fs.readFile(historyPath(scope, id), "utf-8");
		return JSON.parse(data) as ResourceMetricSnapshot[];
	} catch {
		return [];
	}
};

export const recordResourceMetricSnapshot = async (
	scope: "project" | "service",
	id: string,
	snapshot: ResourceMetricSnapshot,
) => {
	const filePath = historyPath(scope, id);
	await fs.mkdir(path.dirname(filePath), { recursive: true });

	const history = await readResourceMetricHistory(scope, id);
	const last = history.at(-1);
	const shouldReplaceLast =
		last &&
		new Date(snapshot.time).getTime() - new Date(last.time).getTime() <
			MIN_SAMPLE_INTERVAL_MS;

	const nextHistory = shouldReplaceLast
		? [...history.slice(0, -1), snapshot]
		: [...history, snapshot];
	const limitedHistory = nextHistory.slice(-HISTORY_LIMIT);

	await fs.writeFile(filePath, JSON.stringify(limitedHistory));
	return limitedHistory;
};

export const aggregateResourceMetricSnapshots = (
	snapshots: ResourceMetricSnapshot[],
) => {
	const aggregate = emptySnapshot();
	aggregate.time = new Date().toISOString();

	for (const snapshot of snapshots) {
		aggregate.cpuPercent += snapshot.cpuPercent;
		aggregate.memoryBytes += snapshot.memoryBytes;
		aggregate.memoryLimitBytes += snapshot.memoryLimitBytes;
		aggregate.blockReadBytes += snapshot.blockReadBytes;
		aggregate.blockWriteBytes += snapshot.blockWriteBytes;
		aggregate.networkRxBytes += snapshot.networkRxBytes;
		aggregate.networkTxBytes += snapshot.networkTxBytes;
		aggregate.containers += snapshot.containers;
	}

	return aggregate;
};

export const collectResourceMetricsForServices = async (
	services: ResourceMetricService[],
) => {
	const summaries: Record<string, ResourceMetricSummary> = {};
	const servicesByServer = new Map<string, ResourceMetricService[]>();

	for (const service of services) {
		const serverKey = service.serverId ?? "dokploy";
		servicesByServer.set(serverKey, [
			...(servicesByServer.get(serverKey) ?? []),
			service,
		]);
	}

	for (const [serverKey, serverServices] of servicesByServer) {
		const serverId = serverKey === "dokploy" ? undefined : serverKey;
		const [stats, containers] = await Promise.all([
			getAllContainerStats(serverId),
			listContainerLabels(serverId),
		]);

		for (const service of serverServices) {
			const serviceContainers = containers.filter((container) =>
				serviceOwnsContainer(service, container),
			);
			const rows = serviceContainers
				.map((container) =>
					findStatsForContainer(stats, container.id, container.name),
				)
				.filter((row): row is DockerStatsRow => Boolean(row));

			const current = aggregateRows(rows);
			const history = await recordResourceMetricSnapshot(
				"service",
				service.serviceId,
				current,
			);

			summaries[service.serviceId] = {
				current,
				history,
			};
		}
	}

	return summaries;
};
