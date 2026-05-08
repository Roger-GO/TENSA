// v0.1 placeholder shell. Real shell (TopBar / LeftRail / RightDock /
// SldCanvas) lands in Units 4 + 7 + 8 + 9. Unit 1 only verifies the
// scaffold compiles + serves a non-empty page.
export function App() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold tracking-tight">ANDES App</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Web UI scaffold (Unit 1). Layout shell, design system, and SLD canvas land in subsequent
          units.
        </p>
      </div>
    </main>
  );
}
