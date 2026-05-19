import { ResourceUsageStrip } from "@/components/dashboard/resource-metrics/usage-strip";
import { api } from "@/utils/api";

type RouteParam = string | string[] | undefined;

interface Props {
	projectId: RouteParam;
	environmentId: RouteParam;
	serviceId?: string;
	className?: string;
}

const firstRouteParam = (value: RouteParam) =>
	Array.isArray(value) ? value[0] : value;

export const ServiceResourceUsage = ({
	projectId,
	environmentId,
	serviceId,
	className,
}: Props) => {
	const resolvedProjectId = firstRouteParam(projectId);
	const resolvedEnvironmentId = firstRouteParam(environmentId);
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data } = api.project.resourceMetrics.useQuery(
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

	if (!serviceId) {
		return null;
	}

	return (
		<ResourceUsageStrip
			metrics={data?.services[serviceId]}
			compact
			className={className}
		/>
	);
};
