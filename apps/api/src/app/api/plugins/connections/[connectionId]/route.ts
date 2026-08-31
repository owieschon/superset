import { auth } from "@superset/auth/server";
import { disconnect } from "@/lib/plugins/connections";

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ connectionId: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { connectionId } = await params;
	const removed = await disconnect(session.user.id, connectionId);
	if (!removed) {
		return Response.json({ error: "Connection not found" }, { status: 404 });
	}
	return Response.json({ disconnected: connectionId });
}
