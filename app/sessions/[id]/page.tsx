import { Suspense } from "react";
import SessionLoader from "@/components/SessionLoader";

/**
 * The session id is a runtime value, so it is read inside a `<Suspense>` boundary: the rest of the
 * shell can still be prerendered and a direct visit is not blocked while the id resolves.
 */
export default function SessionPage(props: PageProps<"/sessions/[id]">) {
  return (
    <Suspense fallback={<RouteFallback />}>
      <SessionRoute params={props.params} />
    </Suspense>
  );
}

async function SessionRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionLoader id={id} />;
}

function RouteFallback() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex items-center gap-2 text-xs text-fog">
        <span className="size-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
        Opening session…
      </div>
    </div>
  );
}
