#!/usr/bin/env bash
set -euo pipefail

DEFAULT_HOST="${DOKPLOY_HOST:-ubuntu@dokploy.thesolarium.io}"
HOST="$DEFAULT_HOST"
SERVICE="${DOKPLOY_SERVICE:-dokploy}"
STATE_DIR="${DOKPLOY_STATE_DIR:-/var/lib/dokploy-personal-deploy}"
TIMEOUT="${DOKPLOY_DEPLOY_TIMEOUT:-600}"
IMAGE="${DOKPLOY_IMAGE:-}"
REGISTRY="${DOKPLOY_REGISTRY:-ghcr.io}"
REGISTRY_USER="${REGISTRY_USER:-${GHCR_USER:-}}"
REGISTRY_TOKEN="${REGISTRY_TOKEN:-${GHCR_TOKEN:-}}"
SKIP_REGISTRY_LOGIN="${DOKPLOY_SKIP_REGISTRY_LOGIN:-0}"
NO_PULL="${DOKPLOY_NO_PULL:-0}"

usage() {
	cat <<'USAGE'
Usage:
  ops/dokploy-personal-deploy.sh migrate --image IMAGE [options]
  ops/dokploy-personal-deploy.sh rollback [--image IMAGE] [options]
  ops/dokploy-personal-deploy.sh status [options]
  ops/dokploy-personal-deploy.sh history [options]

Default target:
  host:    ubuntu@dokploy.thesolarium.io
  service: dokploy

Commands:
  migrate   Update the remote Docker Swarm service to IMAGE and save the previous image for rollback.
  rollback  Revert to the previous image saved by the last migrate, or to --image if provided.
  status    Show the current service image, replica status, update status, and recent tasks.
  history   Show saved deploy and rollback metadata files on the remote host.

Options:
  --host HOST                  SSH host. Default: $DOKPLOY_HOST or ubuntu@dokploy.thesolarium.io.
  --service SERVICE            Docker Swarm service name. Default: $DOKPLOY_SERVICE or dokploy.
  --image IMAGE                Full image ref, for example ghcr.io/cromulus/my-dokploy:canary-plus-abc123.
  --state-dir DIR              Remote state dir. Default: /var/lib/dokploy-personal-deploy.
  --timeout SECONDS            Service convergence timeout. Default: 600.
  --registry REGISTRY          Registry for login. Default: ghcr.io.
  --registry-user USER         Registry username. Can also use REGISTRY_USER or GHCR_USER.
  --registry-token TOKEN       Registry token. Prefer REGISTRY_TOKEN or GHCR_TOKEN instead of this flag.
  --skip-registry-login        Do not run docker login on the remote host.
  --no-pull                    Do not pre-pull the target image before service update.
  -h, --help                   Show this help.

Private GHCR example:
  GHCR_USER=cromulus GHCR_TOKEN=github_pat_xxx \
    ops/dokploy-personal-deploy.sh migrate \
      --image ghcr.io/cromulus/my-dokploy:canary-plus-abc123

Rollback example:
  ops/dokploy-personal-deploy.sh rollback

Important:
  Rollback reverts the Dokploy service image only. If the new image ran database migrations,
  confirm compatibility before rolling back, or restore a database backup separately.
USAGE
}

die() {
	echo "error: $*" >&2
	exit 1
}

shell_quote() {
	printf "%q" "$1"
}

require_value() {
	local flag="$1"
	local value="${2:-}"
	[[ -n "$value" ]] || die "$flag requires a value"
}

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
	usage
	exit 2
fi
shift || true

case "$COMMAND" in
	migrate | rollback | status | history)
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die "unknown command: $COMMAND"
		;;
esac

while [[ $# -gt 0 ]]; do
	case "$1" in
		--host)
			require_value "$1" "${2:-}"
			HOST="$2"
			shift 2
			;;
		--service)
			require_value "$1" "${2:-}"
			SERVICE="$2"
			shift 2
			;;
		--image)
			require_value "$1" "${2:-}"
			IMAGE="$2"
			shift 2
			;;
		--state-dir)
			require_value "$1" "${2:-}"
			STATE_DIR="$2"
			shift 2
			;;
		--timeout)
			require_value "$1" "${2:-}"
			TIMEOUT="$2"
			shift 2
			;;
		--registry)
			require_value "$1" "${2:-}"
			REGISTRY="$2"
			shift 2
			;;
		--registry-user | --ghcr-user)
			require_value "$1" "${2:-}"
			REGISTRY_USER="$2"
			shift 2
			;;
		--registry-token | --ghcr-token)
			require_value "$1" "${2:-}"
			REGISTRY_TOKEN="$2"
			shift 2
			;;
		--skip-registry-login)
			SKIP_REGISTRY_LOGIN=1
			shift
			;;
		--no-pull)
			NO_PULL=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			die "unknown option: $1"
			;;
	esac
done

[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout must be an integer"

if [[ "$COMMAND" == "migrate" && -z "$IMAGE" ]]; then
	die "migrate requires --image IMAGE"
fi

remote_docker_login() {
	if [[ "$COMMAND" != "migrate" && "$COMMAND" != "rollback" ]]; then
		return
	fi

	if [[ "$SKIP_REGISTRY_LOGIN" == "1" ]]; then
		echo "Skipping remote registry login."
		return
	fi

	if [[ -z "$REGISTRY_TOKEN" ]]; then
		echo "No REGISTRY_TOKEN/GHCR_TOKEN provided; assuming the image is public or the remote host is already logged in."
		return
	fi

	[[ -n "$REGISTRY_USER" ]] || die "set REGISTRY_USER/GHCR_USER when providing a registry token"

	local registry_q
	local user_q
	registry_q="$(shell_quote "$REGISTRY")"
	user_q="$(shell_quote "$REGISTRY_USER")"

	echo "Logging into $REGISTRY on $HOST as $REGISTRY_USER."
	printf "%s" "$REGISTRY_TOKEN" | ssh "$HOST" "sudo -n docker login $registry_q --username $user_q --password-stdin"
}

run_remote() {
	ssh "$HOST" bash -s -- "$COMMAND" "$SERVICE" "$IMAGE" "$STATE_DIR" "$TIMEOUT" "$NO_PULL" <<'REMOTE'
set -euo pipefail

command="$1"
service="$2"
requested_image="$3"
state_dir="$4"
timeout="$5"
no_pull="$6"

die() {
	echo "error: $*" >&2
	exit 1
}

log() {
	printf "[%s] %s\n" "$(date -u +%H:%M:%SZ)" "$*"
}

docker_cmd() {
	sudo -n docker "$@"
}

require_sudo() {
	sudo -n true >/dev/null 2>&1 || die "passwordless sudo is required on the remote host"
}

require_service() {
	docker_cmd service inspect "$service" >/dev/null 2>&1 || die "Docker Swarm service not found: $service"
}

current_image() {
	docker_cmd service inspect "$service" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
}

desired_replicas() {
	docker_cmd service inspect "$service" --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{else}}global{{end}}'
}

running_replicas() {
	docker_cmd service ps "$service" --filter desired-state=running --format '{{.CurrentState}}' | grep -c '^Running' || true
}

update_state() {
	docker_cmd service inspect "$service" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null || true
}

update_message() {
	docker_cmd service inspect "$service" --format '{{if .UpdateStatus}}{{.UpdateStatus.Message}}{{end}}' 2>/dev/null || true
}

is_integer() {
	[[ "$1" =~ ^[0-9]+$ ]]
}

show_service_status() {
	local image desired running state message
	image="$(current_image)"
	desired="$(desired_replicas)"
	running="$(running_replicas)"
	state="$(update_state)"
	message="$(update_message)"

	echo "Service: $service"
	echo "Image:   $image"
	echo "Tasks:   $running/$desired running"
	echo "Update:  ${state:-none}"
	if [[ -n "$message" ]]; then
		echo "Message: $message"
	fi
	echo
	docker_cmd service ps "$service" --no-trunc
}

write_state() {
	local kind="$1"
	local previous="$2"
	local target="$3"
	local ts state_file inspect_file

	ts="$(date -u +%Y%m%dT%H%M%SZ)"
	state_file="$state_dir/${kind}-${ts}.env"
	inspect_file="$state_dir/${kind}-${ts}.service.json"

	sudo -n mkdir -p "$state_dir"
	docker_cmd service inspect "$service" | sudo -n tee "$inspect_file" >/dev/null

	{
		printf "timestamp=%q\n" "$ts"
		printf "kind=%q\n" "$kind"
		printf "service=%q\n" "$service"
		printf "previous_image=%q\n" "$previous"
		printf "target_image=%q\n" "$target"
		printf "inspect_file=%q\n" "$inspect_file"
	} | sudo -n tee "$state_file" >/dev/null

	sudo -n chmod 0640 "$state_file" "$inspect_file"
	sudo -n ln -sfn "$state_file" "$state_dir/latest-action.env"

	if [[ "$kind" == "deploy" ]]; then
		sudo -n ln -sfn "$state_file" "$state_dir/last-deploy.env"
	elif [[ "$kind" == "rollback" ]]; then
		sudo -n ln -sfn "$state_file" "$state_dir/last-rollback.env"
	fi

	printf "%s\n" "$state_file"
}

last_deploy_previous_image() {
	local last_deploy="$state_dir/last-deploy.env"
	if ! sudo -n test -r "$last_deploy"; then
		die "no saved deploy state found at $last_deploy; pass rollback --image IMAGE explicitly"
	fi

	# shellcheck disable=SC1090
	source <(sudo -n cat "$last_deploy")
	[[ -n "${previous_image:-}" ]] || die "saved deploy state does not contain previous_image"
	printf "%s\n" "$previous_image"
}

pull_image() {
	local image="$1"
	if [[ "$no_pull" == "1" ]]; then
		log "Skipping docker pull for $image"
		return
	fi

	log "Pulling $image"
	docker_cmd pull "$image"
}

wait_for_convergence() {
	local target_image="$1"
	local deadline state message desired running image_now
	deadline=$((SECONDS + timeout))

	while ((SECONDS < deadline)); do
		state="$(update_state)"
		message="$(update_message)"
		desired="$(desired_replicas)"
		running="$(running_replicas)"
		image_now="$(current_image)"

		log "state=${state:-none} tasks=$running/$desired image=$image_now"

		case "$state" in
			completed)
				if [[ "$desired" == "global" ]]; then
					return 0
				fi
				if is_integer "$desired" && ((running >= desired)); then
					return 0
				fi
				;;
			paused | rollback_paused)
				show_service_status
				die "service update paused: ${message:-no message}"
				;;
			rollback_started)
				show_service_status
				die "service update triggered Docker rollback: ${message:-no message}"
				;;
		esac

		if [[ -z "$state" && "$image_now" == "$target_image" && "$desired" != "global" ]]; then
			if is_integer "$desired" && ((running >= desired)); then
				return 0
			fi
		fi

		sleep 5
	done

	show_service_status
	die "timed out after ${timeout}s waiting for $service to converge"
}

migrate() {
	local old_image state_file

	[[ -n "$requested_image" ]] || die "migrate requires an image"

	old_image="$(current_image)"
	state_file="$(write_state deploy "$old_image" "$requested_image")"
	log "Saved deploy state: $state_file"

	pull_image "$requested_image"

	log "Updating $service"
	log "From: $old_image"
	log "To:   $requested_image"
	docker_cmd service update --with-registry-auth --detach=false --image "$requested_image" "$service"

	wait_for_convergence "$requested_image"
	log "Migration complete."
	show_service_status
}

rollback() {
	local target_image old_image state_file

	target_image="$requested_image"
	if [[ -z "$target_image" ]]; then
		target_image="$(last_deploy_previous_image)"
	fi

	old_image="$(current_image)"
	state_file="$(write_state rollback "$old_image" "$target_image")"
	log "Saved rollback state: $state_file"

	pull_image "$target_image"

	log "Rolling back $service"
	log "From: $old_image"
	log "To:   $target_image"
	docker_cmd service update --with-registry-auth --detach=false --image "$target_image" "$service"

	wait_for_convergence "$target_image"
	log "Rollback complete."
	show_service_status
}

history() {
	if ! sudo -n test -d "$state_dir"; then
		echo "No state directory found: $state_dir"
		return
	fi

	echo "State dir: $state_dir"
	echo
	echo "Pointers:"
	for pointer in latest-action.env last-deploy.env last-rollback.env; do
		if sudo -n test -L "$state_dir/$pointer"; then
			printf "  %s -> %s\n" "$pointer" "$(sudo -n readlink -f "$state_dir/$pointer")"
		fi
	done
	echo
	echo "Saved actions:"
	sudo -n find "$state_dir" -maxdepth 1 -type f -name '*.env' -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' | sort -r | head -25
}

require_sudo
require_service

case "$command" in
	migrate)
		migrate
		;;
	rollback)
		rollback
		;;
	status)
		show_service_status
		;;
	history)
		history
		;;
	*)
		die "unknown remote command: $command"
		;;
esac
REMOTE
}

echo "Target host:    $HOST"
echo "Target service: $SERVICE"
echo "State dir:      $STATE_DIR"
if [[ -n "$IMAGE" ]]; then
	echo "Image:          $IMAGE"
fi
echo

remote_docker_login
run_remote
