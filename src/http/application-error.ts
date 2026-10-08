// #610 §8. Fixed public messages; never serialize an exception or its cause.
const errors = {
  INVALID_REQUEST: { status: 400, message: "入力内容を確認してください。", retry: "none" },
  UNAUTHENTICATED: { status: 401, message: "認証が必要です。", retry: "none" },
  FORBIDDEN: { status: 403, message: "この操作は利用できません。", retry: "none" },
  CSRF_INVALID: { status: 403, message: "操作を確認できませんでした。画面を再読み込みしてください。", retry: "reload" },
  RESERVATION_NOT_AVAILABLE: { status: 409, message: "この枠は現在予約できません。予定を再読み込みしてください。", retry: "reload" },
  RESERVATION_WINDOW_CLOSED: { status: 409, message: "この枠の予約受付は終了しました。予定を再読み込みしてください。", retry: "reload" },
  SCHEDULE_MONTH_NOT_AVAILABLE: { status: 404, message: "指定された月の予定は利用できません。", retry: "none" },
  SERVICE_UNAVAILABLE: { status: 503, message: "現在サービスを利用できません。時間をおいて再度お試しください。", retry: "later" },
  INTEGRITY_STATE_UNAVAILABLE: { status: 503, message: "現在予定情報を利用できません。時間をおいて再度お試しください。", retry: "later" },
} as const;

export function errorResponse(code: keyof typeof errors): Response {
  const { status, message, retry } = errors[code];
  const response = Response.json({ error: { code, message, retry } }, {
    status, headers: { "cache-control": "no-store" },
  });
  if (code === "UNAUTHENTICATED") response.headers.set("set-cookie", "__Host-student_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return response;
}

