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
      <div className="mono flex items-center gap-2 text-[0.66rem] uppercase tracking-[0.1em] text-grey">
        <span className="size-3 animate-spin rounded-full border-2 border-quiet border-t-signal" />
        Opening session…
      </div>
    </div>
  );
}
