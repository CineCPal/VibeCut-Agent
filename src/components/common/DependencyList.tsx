import { useSystemStore } from "../../store/useSystemStore";
import { StatusRow } from "./StatusRow";

export function DependencyList() {
  const dependencies = useSystemStore((s) => s.dependencies);
  const loading = useSystemStore((s) => s.loading);

  if (dependencies.length === 0) {
    return <p className="text-xs text-cool-grey">{loading ? "Checking…" : "Not checked yet."}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {dependencies.map((dep) => (
        <StatusRow
          key={dep.name}
          label={dep.name}
          tone={dep.path ? "ok" : "bad"}
          value={dep.path ? (dep.version ?? "Found") : "Not found"}
          detail={dep.path ?? "Install with Homebrew, or add it to PATH"}
        />
      ))}
    </ul>
  );
}
