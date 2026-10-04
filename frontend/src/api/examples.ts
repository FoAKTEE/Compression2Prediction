import { apiClient, seg } from "./client";
import type { ExampleBundle, ExampleSummary, ListExamplesResponse } from "./types";

/** `GET /api/examples`: the worked examples the server can load into a project. */
export async function listExamples(): Promise<ExampleSummary[]> {
  const { data } = await apiClient.get<ListExamplesResponse>("/examples");
  return data.examples;
}

/** `GET /api/examples/:name`: one example's world and model import bodies. */
export async function getExample(name: string): Promise<ExampleBundle> {
  const { data } = await apiClient.get<ExampleBundle>(`/examples/${seg(name)}`);
  return data;
}
