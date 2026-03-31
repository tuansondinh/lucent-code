export type PermissionMode = "danger-full-access" | "accept-on-edit" | "auto";

export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "lsp", "hashline_read"]);
export const MUTATING_TOOLS = new Set(["bash", "edit", "write", "hashline_edit"]);

export interface FileChangeApprovalRequest {
	action: "write" | "edit" | "delete" | "move";
	path: string;
	message: string;
}

export interface ClassifierRequest {
	toolName: string;
	toolCallId: string;
	args: any;
}

type FileChangeApprovalHandler = (request: FileChangeApprovalRequest) => Promise<boolean>;
type ClassifierHandler = (request: ClassifierRequest) => Promise<boolean>;

let fileChangeApprovalHandler: FileChangeApprovalHandler | null = null;
let classifierHandler: ClassifierHandler | null = null;

/**
 * Router for subagent approval/classifier responses.
 * When set, `resolveApprovalResponse` and `resolveClassifierResponse` check this
 * first — if the router handles the id (returns true), local resolution is skipped.
 */
let subagentApprovalRouter: ((proxyId: string, approved: boolean) => boolean) | null = null;
let subagentClassifierRouter: ((proxyId: string, approved: boolean) => boolean) | null = null;

export function setSubagentApprovalRouter(router: ((proxyId: string, approved: boolean) => boolean) | null): void {
	subagentApprovalRouter = router;
}

export function setSubagentClassifierRouter(router: ((proxyId: string, approved: boolean) => boolean) | null): void {
	subagentClassifierRouter = router;
}

/** Pending approval requests awaiting a response from the host (keyed by id). */
const pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();

/** Pending classifier requests awaiting a response from the host (keyed by id). */
const pendingClassifications = new Map<string, { resolve: (approved: boolean) => void }>();

let approvalIdCounter = 0;
let classifierIdCounter = 0;

let permissionModeOverride: PermissionMode | null = null;

export function setPermissionMode(mode: PermissionMode): void {
	permissionModeOverride = mode;
}

export function getPermissionMode(): PermissionMode {
	if (permissionModeOverride !== null) return permissionModeOverride;
	const mode = process.env.LUCENT_CODE_PERMISSION_MODE;
	if (mode === "accept-on-edit") return "accept-on-edit";
	if (mode === "auto") return "auto";
	return "danger-full-access";
}

export function setFileChangeApprovalHandler(handler: FileChangeApprovalHandler | null): void {
	fileChangeApprovalHandler = handler;
}

export function setClassifierHandler(handler: ClassifierHandler | null): void {
	classifierHandler = handler;
}

/**
 * Register the stdout-based approval handler used in supervised (Studio) mode.
 *
 * Sends `{ type: 'approval_request', id, action, path, message }` on stdout
 * and returns a promise that resolves when the host writes back a matching
 * `{ type: 'approval_response', id, approved }` on stdin.
 */
export function registerStdioApprovalHandler(): void {
	setFileChangeApprovalHandler(async (request: FileChangeApprovalRequest): Promise<boolean> => {
		const id = `apr_${++approvalIdCounter}_${Date.now()}`;

		return new Promise<boolean>((resolve) => {
			pendingApprovals.set(id, { resolve });

			const msg = JSON.stringify({
				type: "approval_request",
				id,
				action: request.action,
				path: request.path,
				message: request.message,
			});
			process.stdout.write(msg + "\n");
		});
	});
}

/**
 * Register the stdout-based classifier handler used in Auto mode.
 *
 * Sends `{ type: 'classifier_request', id, toolName, toolCallId, args }` on stdout
 * and returns a promise that resolves when the host writes back a matching
 * `{ type: 'classifier_response', id, approved }` on stdin.
 */
export function registerStdioClassifierHandler(): void {
	setClassifierHandler(async (request: ClassifierRequest): Promise<boolean> => {
		const id = `cls_${++classifierIdCounter}_${Date.now()}`;

		return new Promise<boolean>((resolve) => {
			pendingClassifications.set(id, { resolve });

			const msg = JSON.stringify({
				type: "classifier_request",
				id,
				toolName: request.toolName,
				toolCallId: request.toolCallId,
				args: request.args,
			});
			process.stdout.write(msg + "\n");
			// No timeout — the studio handles all timing (LLM call + user approval card).
			// Matches accept-on-edit mode which also waits indefinitely.
		});
	});
}

/**
 * Called by headless-ui.ts when an `approval_response` arrives on stdin.
 * Resolves the matching pending approval promise.
 */
export function resolveApprovalResponse(id: string, approved: boolean): void {
	if (subagentApprovalRouter && subagentApprovalRouter(id, approved)) return;
	const pending = pendingApprovals.get(id);
	if (pending) {
		pendingApprovals.delete(id);
		pending.resolve(approved);
	}
}

/**
 * Called by rpc-mode.ts when a `classifier_response` arrives on stdin.
 * Resolves the matching pending classifier promise.
 */
export function resolveClassifierResponse(id: string, approved: boolean): void {
	if (subagentClassifierRouter && subagentClassifierRouter(id, approved)) return;
	const pending = pendingClassifications.get(id);
	if (pending) {
		pendingClassifications.delete(id);
		pending.resolve(approved);
	}
}

export async function requestFileChangeApproval(request: FileChangeApprovalRequest): Promise<void> {
	if (getPermissionMode() !== "accept-on-edit") {
		return;
	}

	if (!fileChangeApprovalHandler) {
		throw new Error(`Approval required before ${request.action} on ${request.path}, but no approval handler is configured.`);
	}

	const approved = await fileChangeApprovalHandler(request);
	if (!approved) {
		throw new Error(`User declined ${request.action} for ${request.path}.`);
	}
}

export async function requestClassifierDecision(request: ClassifierRequest): Promise<boolean> {
	if (getPermissionMode() !== "auto") {
		return true;
	}

	if (!classifierHandler) {
		return false;
	}

	return await classifierHandler(request);
}
