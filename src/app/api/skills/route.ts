import { loadSkills } from "@/lib/skills";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List the installed skills (name, description, full playbook body). */
export async function GET() {
  return Response.json(loadSkills());
}
