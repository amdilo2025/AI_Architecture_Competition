export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public fields: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && !path.startsWith("/auth/"))
        window.dispatchEvent(new Event("session-expired"));
      throw new ApiError(
        data.error?.message || "服务请求失败，请重试",
        response.status,
        data.error?.fields || [],
      );
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "无法连接调度服务或请求超时。已保留当前内容，请重试。",
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}
