import type { APIRoute } from "astro";
import { validateRecording } from "../../../../lib/recording.mjs";
import capture from "../../../data/recording.json";
export const prerender = true;
export const GET: APIRoute = () => {
  validateRecording(capture);
  return new Response(JSON.stringify(capture, null, 2) + "\n", {
  headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
