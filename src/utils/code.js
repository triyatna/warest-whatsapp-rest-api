







export const CODES = [
  
  {
    app_code: 1000,
    app_name: "SUCCESS",
    message: "Request successful",
    http_status: 200,
    retryable: false,
    category: "success",
  },
  {
    app_code: 1001,
    app_name: "ACCEPTED",
    message: "Accepted for processing",
    http_status: 202,
    retryable: false,
    category: "success",
  },
  {
    app_code: 1002,
    app_name: "QUEUED",
    message: "Queued for async processing",
    http_status: 202,
    retryable: false,
    category: "success",
  },
  {
    app_code: 1003,
    app_name: "SCHEDULED",
    message: "Scheduled for later execution",
    http_status: 202,
    retryable: false,
    category: "success",
  },
  {
    app_code: 1004,
    app_name: "PARTIAL_SUCCESS",
    message: "Completed with warnings",
    http_status: 207,
    retryable: false,
    category: "success",
  },
  {
    app_code: 1005,
    app_name: "NOOP",
    message: "No changes were needed",
    http_status: 200,
    retryable: false,
    category: "success",
  },

  
  {
    app_code: 1100,
    app_name: "SESSION_REQUIRED",
    message: "Session ID is required",
    http_status: 400,
    retryable: false,
    category: "session",
  },
  {
    app_code: 1101,
    app_name: "SESSION_NOT_FOUND",
    message: "Session not found",
    http_status: 404,
    retryable: false,
    category: "session",
  },
  {
    app_code: 1102,
    app_name: "SESSION_ALREADY_EXISTS",
    message: "Session already exists",
    http_status: 409,
    retryable: false,
    category: "session",
  },
  {
    app_code: 1103,
    app_name: "SESSION_CLOSED",
    message: "Session is closed",
    http_status: 409,
    retryable: true,
    category: "session",
  },
  {
    app_code: 1104,
    app_name: "SESSION_OPEN",
    message: "Session already open",
    http_status: 200,
    retryable: false,
    category: "session",
  },
  {
    app_code: 1105,
    app_name: "SESSION_BUSY",
    message: "Session is busy",
    http_status: 429,
    retryable: true,
    category: "session",
  },
  {
    app_code: 1106,
    app_name: "SESSION_NOT_LOGGED_IN",
    message: "Login required (scan QR or pairing)",
    http_status: 409,
    retryable: true,
    category: "session",
  },
  {
    app_code: 1107,
    app_name: "SESSION_QR_REQUIRED",
    message: "QR required to continue",
    http_status: 202,
    retryable: true,
    category: "session",
  },
  {
    app_code: 1108,
    app_name: "SESSION_QR_EXPIRED",
    message: "QR expired, request a new one",
    http_status: 409,
    retryable: true,
    category: "session",
  },
  {
    app_code: 1109,
    app_name: "SESSION_RECONNECT_SCHEDULED",
    message: "Reconnect scheduled",
    http_status: 202,
    retryable: true,
    category: "session",
  },
  {
    app_code: 1110,
    app_name: "SESSION_LOGIN_PENDING",
    message: "Login is in progress",
    http_status: 202,
    retryable: true,
    category: "session",
  },

  
  {
    app_code: 1200,
    app_name: "WEBHOOK_DISABLED",
    message: "Webhook delivery disabled",
    http_status: 200,
    retryable: false,
    category: "webhook",
  },
  {
    app_code: 1201,
    app_name: "WEBHOOK_INVALID_URL",
    message: "Invalid webhook URL",
    http_status: 400,
    retryable: false,
    category: "webhook",
  },
  {
    app_code: 1202,
    app_name: "WEBHOOK_TIMEOUT",
    message: "Webhook delivery timed out",
    http_status: 504,
    retryable: true,
    category: "webhook",
  },
  {
    app_code: 1203,
    app_name: "WEBHOOK_REJECTED",
    message: "Remote endpoint rejected payload",
    http_status: 502,
    retryable: true,
    category: "webhook",
  },
  {
    app_code: 1204,
    app_name: "WEBHOOK_SIGNATURE_INVALID",
    message: "Invalid webhook signature",
    http_status: 401,
    retryable: false,
    category: "webhook",
  },

  
  {
    app_code: 1400,
    app_name: "SOCKET_UNAUTHORIZED",
    message: "WebSocket unauthorized",
    http_status: 401,
    retryable: false,
    category: "socket",
  },
  {
    app_code: 1401,
    app_name: "SOCKET_RATE_LIMITED",
    message: "Too many socket messages",
    http_status: 429,
    retryable: true,
    category: "socket",
  },
  {
    app_code: 1402,
    app_name: "SOCKET_ROOM_NOT_FOUND",
    message: "Room not found",
    http_status: 404,
    retryable: false,
    category: "socket",
  },
  {
    app_code: 1403,
    app_name: "SOCKET_ALREADY_JOINED",
    message: "Already joined this room",
    http_status: 200,
    retryable: false,
    category: "socket",
  },
  {
    app_code: 1404,
    app_name: "SOCKET_NOT_CONNECTED",
    message: "Socket not connected",
    http_status: 503,
    retryable: true,
    category: "socket",
  },

  
  {
    app_code: 1600,
    app_name: "SSE_UNAVAILABLE",
    message: "SSE stream unavailable",
    http_status: 503,
    retryable: true,
    category: "sse",
  },
  {
    app_code: 1601,
    app_name: "SSE_CLIENT_DISCONNECTED",
    message: "SSE client disconnected",
    http_status: 499,
    retryable: true,
    category: "sse",
  },

  
  {
    app_code: 2000,
    app_name: "BAD_REQUEST",
    message: "Invalid request",
    http_status: 400,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2001,
    app_name: "MISSING_PARAMETER",
    message: "Required parameter missing",
    http_status: 400,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2002,
    app_name: "INVALID_PARAMETER",
    message: "Parameter is invalid",
    http_status: 400,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2003,
    app_name: "INVALID_STATE",
    message: "Operation not allowed in current state",
    http_status: 409,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2004,
    app_name: "CONFLICT",
    message: "Resource conflict",
    http_status: 409,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2005,
    app_name: "UNSUPPORTED_OPERATION",
    message: "Operation not supported",
    http_status: 400,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2006,
    app_name: "PAYLOAD_TOO_LARGE",
    message: "Payload too large",
    http_status: 413,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2007,
    app_name: "UNSUPPORTED_MEDIA_TYPE",
    message: "Unsupported media type",
    http_status: 415,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2008,
    app_name: "MALFORMED_JSON",
    message: "Malformed JSON body",
    http_status: 400,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2009,
    app_name: "DUPLICATE_REQUEST",
    message: "Duplicate request detected",
    http_status: 409,
    retryable: true,
    category: "validation",
  },
  {
    app_code: 2010,
    app_name: "METHOD_NOT_ALLOWED",
    message: "Method not allowed",
    http_status: 405,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2011,
    app_name: "NOT_ACCEPTABLE",
    message: "Not acceptable",
    http_status: 406,
    retryable: false,
    category: "validation",
  },
  {
    app_code: 2012,
    app_name: "UNPROCESSABLE_ENTITY",
    message: "Unprocessable entity",
    http_status: 422,
    retryable: false,
    category: "validation",
  },

  
  {
    app_code: 2200,
    app_name: "UNAUTHORIZED",
    message: "Missing or invalid credentials",
    http_status: 401,
    retryable: false,
    category: "auth",
  },
  {
    app_code: 2201,
    app_name: "FORBIDDEN",
    message: "Insufficient permissions",
    http_status: 403,
    retryable: false,
    category: "auth",
  },
  {
    app_code: 2202,
    app_name: "TOKEN_EXPIRED",
    message: "Token expired",
    http_status: 401,
    retryable: true,
    category: "auth",
  },
  {
    app_code: 2203,
    app_name: "TOKEN_INVALID",
    message: "Token invalid",
    http_status: 401,
    retryable: false,
    category: "auth",
  },
  {
    app_code: 2204,
    app_name: "API_KEY_INVALID",
    message: "API key invalid",
    http_status: 401,
    retryable: false,
    category: "auth",
  },
  {
    app_code: 2205,
    app_name: "INSUFFICIENT_SCOPE",
    message: "Scope does not allow this operation",
    http_status: 403,
    retryable: false,
    category: "auth",
  },

  
  {
    app_code: 2400,
    app_name: "RATE_LIMITED",
    message: "Rate limit exceeded",
    http_status: 429,
    retryable: true,
    category: "throttle",
  },
  {
    app_code: 2401,
    app_name: "QUOTA_EXCEEDED",
    message: "Quota exceeded",
    http_status: 429,
    retryable: true,
    category: "throttle",
  },
  {
    app_code: 2402,
    app_name: "CONCURRENCY_LIMIT",
    message: "Too many concurrent operations",
    http_status: 429,
    retryable: true,
    category: "throttle",
  },

  
  {
    app_code: 2600,
    app_name: "NOT_FOUND",
    message: "Resource not found",
    http_status: 404,
    retryable: false,
    category: "lookup",
  },
  {
    app_code: 2601,
    app_name: "MESSAGE_NOT_FOUND",
    message: "Message not found",
    http_status: 404,
    retryable: false,
    category: "lookup",
  },
  {
    app_code: 2602,
    app_name: "USER_NOT_FOUND",
    message: "User/contact not found",
    http_status: 404,
    retryable: false,
    category: "lookup",
  },
  {
    app_code: 2603,
    app_name: "CHAT_NOT_FOUND",
    message: "Chat not found",
    http_status: 404,
    retryable: false,
    category: "lookup",
  },
  {
    app_code: 2604,
    app_name: "GROUP_NOT_FOUND",
    message: "Group not found",
    http_status: 404,
    retryable: false,
    category: "lookup",
  },
  {
    app_code: 2605,
    app_name: "MEDIA_NOT_FOUND",
    message: "Media not found",
    http_status: 404,
    retryable: false,
    category: "lookup",
  },

  
  {
    app_code: 2800,
    app_name: "DOWNSTREAM_ERROR",
    message: "Upstream provider error",
    http_status: 502,
    retryable: true,
    category: "network",
  },
  {
    app_code: 2801,
    app_name: "DOWNSTREAM_TIMEOUT",
    message: "Upstream provider timeout",
    http_status: 504,
    retryable: true,
    category: "network",
  },
  {
    app_code: 2802,
    app_name: "DNS_ERROR",
    message: "DNS resolution error",
    http_status: 502,
    retryable: true,
    category: "network",
  },
  {
    app_code: 2803,
    app_name: "NETWORK_ERROR",
    message: "Network error",
    http_status: 503,
    retryable: true,
    category: "network",
  },

  
  {
    app_code: 3000,
    app_name: "SEND_QUEUED",
    message: "Message queued to send",
    http_status: 202,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3001,
    app_name: "SEND_THROTTLED",
    message: "Send delayed due to throttling",
    http_status: 429,
    retryable: true,
    category: "send",
  },
  {
    app_code: 3002,
    app_name: "SEND_FAILED",
    message: "Failed to send message",
    http_status: 502,
    retryable: true,
    category: "send",
  },
  {
    app_code: 3003,
    app_name: "MEDIA_UPLOAD_FAILED",
    message: "Failed to upload media",
    http_status: 502,
    retryable: true,
    category: "send",
  },
  {
    app_code: 3004,
    app_name: "UNSUPPORTED_MESSAGE_TYPE",
    message: "Unsupported message type",
    http_status: 400,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3005,
    app_name: "RECIPIENT_NOT_ALLOWED",
    message: "Recipient not allowed",
    http_status: 403,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3006,
    app_name: "RECIPIENT_BLOCKED",
    message: "Recipient is blocked or has blocked you",
    http_status: 403,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3007,
    app_name: "RECIPIENT_INVALID",
    message: "Invalid recipient format",
    http_status: 400,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3008,
    app_name: "TEMPLATE_NOT_FOUND",
    message: "Message template not found",
    http_status: 404,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3009,
    app_name: "TEMPLATE_REJECTED",
    message: "Template rejected by provider",
    http_status: 422,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3010,
    app_name: "BUTTONS_LIMIT_EXCEEDED",
    message: "Buttons count exceeds limit",
    http_status: 400,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3011,
    app_name: "LIST_FORMAT_INVALID",
    message: "List message format invalid",
    http_status: 400,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3012,
    app_name: "POLL_INVALID",
    message: "Poll payload invalid",
    http_status: 400,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3013,
    app_name: "STICKER_CONVERT_FAILED",
    message: "Sticker conversion failed",
    http_status: 502,
    retryable: true,
    category: "send",
  },
  {
    app_code: 3014,
    app_name: "CAPTION_TOO_LONG",
    message: "Caption exceeds limit",
    http_status: 400,
    retryable: false,
    category: "send",
  },
  {
    app_code: 3015,
    app_name: "MESSAGE_TOO_LONG",
    message: "Message exceeds length limit",
    http_status: 400,
    retryable: false,
    category: "send",
  },

  
  {
    app_code: 4000,
    app_name: "MESSAGE_DELETE_FAILED",
    message: "Failed to delete message",
    http_status: 502,
    retryable: true,
    category: "manage",
  },
  {
    app_code: 4001,
    app_name: "MESSAGE_EDIT_NOT_ALLOWED",
    message: "Editing this message is not allowed",
    http_status: 403,
    retryable: false,
    category: "manage",
  },
  {
    app_code: 4002,
    app_name: "MESSAGE_FORWARD_FAILED",
    message: "Failed to forward message",
    http_status: 502,
    retryable: true,
    category: "manage",
  },
  {
    app_code: 4003,
    app_name: "MESSAGE_PIN_NOT_ALLOWED",
    message: "Pin/unpin not allowed",
    http_status: 403,
    retryable: false,
    category: "manage",
  },
  {
    app_code: 4004,
    app_name: "MESSAGE_ALREADY_DELETED",
    message: "Message already deleted",
    http_status: 409,
    retryable: false,
    category: "manage",
  },
  {
    app_code: 4005,
    app_name: "REACTION_FAILED",
    message: "Failed to react to message",
    http_status: 502,
    retryable: true,
    category: "manage",
  },

  
  {
    app_code: 4500,
    app_name: "CHAT_ARCHIVE_FAILED",
    message: "Failed to archive chat",
    http_status: 502,
    retryable: true,
    category: "chat",
  },
  {
    app_code: 4501,
    app_name: "CHAT_UNARCHIVE_FAILED",
    message: "Failed to unarchive chat",
    http_status: 502,
    retryable: true,
    category: "chat",
  },
  {
    app_code: 4502,
    app_name: "CHAT_MUTE_FAILED",
    message: "Failed to mute chat",
    http_status: 502,
    retryable: true,
    category: "chat",
  },
  {
    app_code: 4503,
    app_name: "CHAT_MARK_READ_FAILED",
    message: "Failed to mark as read",
    http_status: 502,
    retryable: true,
    category: "chat",
  },
  {
    app_code: 4504,
    app_name: "CHAT_MARK_UNREAD_FAILED",
    message: "Failed to mark as unread",
    http_status: 502,
    retryable: true,
    category: "chat",
  },

  
  {
    app_code: 5000,
    app_name: "GROUP_CREATE_FAILED",
    message: "Failed to create group",
    http_status: 502,
    retryable: true,
    category: "group",
  },
  {
    app_code: 5001,
    app_name: "GROUP_UPDATE_FAILED",
    message: "Failed to update group settings",
    http_status: 502,
    retryable: true,
    category: "group",
  },
  {
    app_code: 5002,
    app_name: "GROUP_ADD_PARTICIPANT_FAILED",
    message: "Failed to add participant",
    http_status: 502,
    retryable: true,
    category: "group",
  },
  {
    app_code: 5003,
    app_name: "GROUP_REMOVE_PARTICIPANT_FAILED",
    message: "Failed to remove participant",
    http_status: 502,
    retryable: true,
    category: "group",
  },
  {
    app_code: 5004,
    app_name: "GROUP_PROMOTE_FAILED",
    message: "Failed to promote participant",
    http_status: 502,
    retryable: true,
    category: "group",
  },
  {
    app_code: 5005,
    app_name: "GROUP_DEMOTE_FAILED",
    message: "Failed to demote participant",
    http_status: 502,
    retryable: true,
    category: "group",
  },
  {
    app_code: 5006,
    app_name: "GROUP_INVITE_FAILED",
    message: "Failed to create invite",
    http_status: 502,
    retryable: true,
    category: "group",
  },
  {
    app_code: 5007,
    app_name: "GROUP_LEAVE_FAILED",
    message: "Failed to leave group",
    http_status: 502,
    retryable: true,
    category: "group",
  },
  {
    app_code: 5008,
    app_name: "GROUP_NOT_ADMIN",
    message: "Operation requires admin privileges",
    http_status: 403,
    retryable: false,
    category: "group",
  },
  {
    app_code: 5009,
    app_name: "GROUP_SUBJECT_TOO_LONG",
    message: "Group subject too long",
    http_status: 400,
    retryable: false,
    category: "group",
  },
  {
    app_code: 5010,
    app_name: "GROUP_DESCRIPTION_TOO_LONG",
    message: "Group description too long",
    http_status: 400,
    retryable: false,
    category: "group",
  },

  
  {
    app_code: 5500,
    app_name: "MEDIA_DOWNLOAD_FAILED",
    message: "Failed to download media",
    http_status: 502,
    retryable: true,
    category: "media",
  },
  {
    app_code: 5501,
    app_name: "MEDIA_PROCESSING",
    message: "Media processing in progress",
    http_status: 202,
    retryable: true,
    category: "media",
  },
  {
    app_code: 5502,
    app_name: "MEDIA_UNSUPPORTED_FORMAT",
    message: "Media format not supported",
    http_status: 415,
    retryable: false,
    category: "media",
  },
  {
    app_code: 5503,
    app_name: "MEDIA_TOO_LARGE",
    message: "Media size exceeds limit",
    http_status: 413,
    retryable: false,
    category: "media",
  },
  {
    app_code: 5504,
    app_name: "MEDIA_NOT_AVAILABLE",
    message: "Media no longer available",
    http_status: 410,
    retryable: false,
    category: "media",
  },

  
  {
    app_code: 6000,
    app_name: "ME_INFO_UNAVAILABLE",
    message: "Current user info unavailable",
    http_status: 503,
    retryable: true,
    category: "user",
  },
  {
    app_code: 6001,
    app_name: "CONTACT_NOT_FOUND",
    message: "Contact not found",
    http_status: 404,
    retryable: false,
    category: "user",
  },
  {
    app_code: 6002,
    app_name: "CONTACT_BLOCK_FAILED",
    message: "Failed to block contact",
    http_status: 502,
    retryable: true,
    category: "user",
  },
  {
    app_code: 6003,
    app_name: "CONTACT_UNBLOCK_FAILED",
    message: "Failed to unblock contact",
    http_status: 502,
    retryable: true,
    category: "user",
  },
  {
    app_code: 6004,
    app_name: "PRESENCE_UNAVAILABLE",
    message: "Presence not available",
    http_status: 503,
    retryable: true,
    category: "user",
  },

  
  {
    app_code: 7000,
    app_name: "JOB_SCHEDULED",
    message: "Job scheduled",
    http_status: 202,
    retryable: false,
    category: "jobs",
  },
  {
    app_code: 7001,
    app_name: "JOB_RUNNING",
    message: "Job currently running",
    http_status: 200,
    retryable: false,
    category: "jobs",
  },
  {
    app_code: 7002,
    app_name: "JOB_COMPLETED",
    message: "Job completed",
    http_status: 200,
    retryable: false,
    category: "jobs",
  },
  {
    app_code: 7003,
    app_name: "JOB_FAILED",
    message: "Job failed",
    http_status: 500,
    retryable: true,
    category: "jobs",
  },
  {
    app_code: 7004,
    app_name: "JOB_CANCELLED",
    message: "Job cancelled",
    http_status: 200,
    retryable: false,
    category: "jobs",
  },
  {
    app_code: 7005,
    app_name: "JOB_NOT_FOUND",
    message: "Job not found",
    http_status: 404,
    retryable: false,
    category: "jobs",
  },

  
  {
    app_code: 8000,
    app_name: "INTERNAL_ERROR",
    message: "Unexpected server error",
    http_status: 500,
    retryable: true,
    category: "server",
  },
  {
    app_code: 8001,
    app_name: "SERVICE_UNAVAILABLE",
    message: "Service temporarily unavailable",
    http_status: 503,
    retryable: true,
    category: "server",
  },
  {
    app_code: 8002,
    app_name: "TIMEOUT",
    message: "Operation timed out",
    http_status: 504,
    retryable: true,
    category: "server",
  },
  {
    app_code: 8003,
    app_name: "DATABASE_ERROR",
    message: "Database error",
    http_status: 500,
    retryable: true,
    category: "server",
  },
  {
    app_code: 8004,
    app_name: "CACHE_ERROR",
    message: "Cache error",
    http_status: 500,
    retryable: true,
    category: "server",
  },
  {
    app_code: 8005,
    app_name: "NOT_IMPLEMENTED",
    message: "Not implemented",
    http_status: 501,
    retryable: false,
    category: "server",
  },
  {
    app_code: 8006,
    app_name: "FEATURE_FLAG_DISABLED",
    message: "Feature is disabled",
    http_status: 403,
    retryable: false,
    category: "server",
  },
];

const INDEX_BY_NAME = new Map(
  CODES.map((c) => [String(c.app_name).toUpperCase(), c])
);
const INDEX_BY_CODE = new Map(CODES.map((c) => [Number(c.app_code), c]));

export function getCode(def) {
  if (def == null) return INDEX_BY_NAME.get("INTERNAL_ERROR");
  if (typeof def === "number")
    return INDEX_BY_CODE.get(def) || INDEX_BY_NAME.get("INTERNAL_ERROR");
  const key = String(def).toUpperCase();
  return INDEX_BY_NAME.get(key) || INDEX_BY_NAME.get("INTERNAL_ERROR");
}

export function isOkStatus(httpStatus) {
  return Number(httpStatus) >= 200 && Number(httpStatus) < 300;
}

export function makePayload(
  codeOrName,
  { message, result = null, overrideStatus } = {}
) {
  const c = getCode(codeOrName);
  const http = c.http_status || 500;
  const ok = overrideStatus != null ? !!overrideStatus : isOkStatus(http);
  const list = Array.isArray(result)
    ? result.filter((item) => item !== undefined)
    : result == null
    ? []
    : [result];
  return {
    status: ok,
    code: c.app_code,
    message: message ?? "",
    results: list,
  };
}


export function send(
  res,
  codeOrName,
  { message, result = null, overrideStatus } = {}
) {
  const c = getCode(codeOrName);
  const payload = makePayload(codeOrName, { message, result, overrideStatus });
  return res.status(c.http_status || 500).json(payload);
}


export function byName(name) {
  return getCode(name);
}
export function byCode(appCode) {
  return getCode(Number(appCode));
}
