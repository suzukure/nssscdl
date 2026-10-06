// Bootstrap only; no product endpoints or external side effects.
export default {
  fetch(): Response {
    return new Response("Application is not available.", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};
