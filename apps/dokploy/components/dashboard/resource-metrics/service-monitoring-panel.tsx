import {
	Activity,
	Cpu,
	HardDrive,
	type LucideIcon,
	MemoryStick,
	Network,
} from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";

type RouteParam = string | string[] | undefined;
type ResourceMetricsSummary =
	RouterOutputs["project"]["resourceMetrics"]["services"][string];
type ResourceMetricSnapshot = NonNullable<ResourceMetricsSummary["current"]>;

interface Props {
	projectId: RouteParam;
	environmentId: RouteParam;
	serviceId?: string;
	className?: string;
}

const firstRouteParam = (value: RouteParam) =>
	Array.isArray(value) ? value[0] : value;

const formatBytes = (bytes?: number) => {
	if (!bytes || bytes <= 0) return "0B";

	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unitIndex]}`;
};

const formatPercent = (value?: number) => {
	if (!value || value <= 0) return "0%";
	return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}%`;
};

const boundedPercent = (value: number) =>
	Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

const Sparkline = ({
	values,
	className,
}: {
	values: number[];
	className?: string;
}) => {
	if (values.length < 2) {
		return <div className={cn("h-12 rounded-md bg-muted/40", className)} />;
	}

	const width = 160;
	const height = 48;
	const max = Math.max(...values, 1);
	const min = Math.min(...values, 0);
	const range = Math.max(max - min, 1);
	const points = values
		.map((value, index) => {
			const x = (index / (values.length - 1)) * width;
			const y = height - ((value - min) / range) * height;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");

	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			className={cn("h-12 w-full overflow-visible", className)}
			aria-hidden="true"
		>
			<polyline
				points={points}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
};

const MetricCard = ({
	icon: Icon,
	label,
	value,
	description,
	progress,
	values,
}: {
	icon: LucideIcon;
	label: string;
	value: string;
	description: string;
	progress?: number;
	values: number[];
}) => (
	<Card className="bg-background">
		<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
			<CardTitle className="font-medium text-sm">{label}</CardTitle>
			<Icon className="size-4 text-muted-foreground" />
		</CardHeader>
		<CardContent className="space-y-3">
			<div className="font-mono text-2xl">{value}</div>
			{typeof progress === "number" && (
				<Progress value={boundedPercent(progress)} className="h-2" />
			)}
			<Sparkline values={values} className="text-primary" />
			<p className="text-muted-foreground text-xs">{description}</p>
		</CardContent>
	</Card>
);

const getHistoryValues = (
	history: ResourceMetricSnapshot[],
	selector: (snapshot: ResourceMetricSnapshot) => number,
) => history.slice(-60).map(selector);

export const ServiceMonitoringPanel = ({
	projectId,
	environmentId,
	serviceId,
	className,
}: Props) => {
	const resolvedProjectId = firstRouteParam(projectId);
	const resolvedEnvironmentId = firstRouteParam(environmentId);
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data, isLoading } = api.project.resourceMetrics.useQuery(
		{
			projectIds: resolvedProjectId ? [resolvedProjectId] : [],
			environmentId: resolvedEnvironmentId,
		},
		{
			enabled:
				!!resolvedProjectId &&
				!!resolvedEnvironmentId &&
				!!serviceId &&
				isCloud === false,
			refetchInterval: 30_000,
		},
	);

	if (isCloud !== false || !serviceId) {
		return null;
	}

	const metrics = data?.services[serviceId];
	const current = metrics?.current;
	const history = metrics?.history ?? [];
	const memoryPercent =
		current?.memoryLimitBytes && current.memoryLimitBytes > 0
			? (current.memoryBytes / current.memoryLimitBytes) * 100
			: 0;

	return (
		<Card className={cn("bg-background", className)}>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-xl">
					<Activity className="size-5 text-muted-foreground" />
					Resource Monitoring
				</CardTitle>
				<CardDescription>
					CPU, memory, Docker block I/O, and network usage for this service.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{!current && isLoading ? (
					<div className="rounded-lg border border-dashed p-6 text-muted-foreground text-sm">
						Loading resource metrics...
					</div>
				) : current ? (
					<>
						<div className="flex flex-wrap gap-2 text-muted-foreground text-xs">
							<span>{current.containers} running container(s)</span>
							<span>
								Last sample:{" "}
								{current.time
									? new Date(current.time).toLocaleTimeString()
									: "never"}
							</span>
							<span>{history.length} retained samples</span>
						</div>
						<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
							<MetricCard
								icon={Cpu}
								label="CPU"
								value={formatPercent(current.cpuPercent)}
								description="Current CPU across running containers"
								progress={current.cpuPercent}
								values={getHistoryValues(
									history,
									(snapshot) => snapshot.cpuPercent,
								)}
							/>
							<MetricCard
								icon={MemoryStick}
								label="Memory"
								value={formatBytes(current.memoryBytes)}
								description={
									current.memoryLimitBytes
										? `${formatPercent(memoryPercent)} of ${formatBytes(current.memoryLimitBytes)} limit`
										: "Current memory usage"
								}
								progress={memoryPercent}
								values={getHistoryValues(
									history,
									(snapshot) => snapshot.memoryBytes,
								)}
							/>
							<MetricCard
								icon={HardDrive}
								label="Disk I/O"
								value={`${formatBytes(current.blockReadBytes)} / ${formatBytes(current.blockWriteBytes)}`}
								description="Read / write from Docker block I/O stats"
								values={getHistoryValues(
									history,
									(snapshot) =>
										snapshot.blockReadBytes + snapshot.blockWriteBytes,
								)}
							/>
							<MetricCard
								icon={Network}
								label="Network"
								value={`${formatBytes(current.networkRxBytes)} / ${formatBytes(current.networkTxBytes)}`}
								description="Input / output from Docker network stats"
								values={getHistoryValues(
									history,
									(snapshot) =>
										snapshot.networkRxBytes + snapshot.networkTxBytes,
								)}
							/>
						</div>
					</>
				) : (
					<div className="rounded-lg border border-dashed p-6 text-muted-foreground text-sm">
						No resource metrics have been collected yet.
					</div>
				)}
			</CardContent>
		</Card>
	);
};
