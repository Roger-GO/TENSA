/**
 * Tests for `<BundleConflictResolver />` (Unit 10 of the v2.0 plan).
 *
 * Pure render component — no network, no store. We feed it
 * synthetic `BundleImportPlan` payloads and assert the right banners /
 * diff layouts appear.
 *
 * Coverage:
 * - Empty plan renders nothing.
 * - andes-version conflict → warning banner with both versions visible.
 * - addfile-missing conflict → blocker banner; "Re-export bundle" CTA
 *   when the prop is wired.
 * - sha-mismatch conflict → side-by-side diff with file metadata; the
 *   radio toggles call back into the parent.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';

import { BundleConflictResolver } from '@/components/bundle/BundleConflictResolver';
import type { BundleImportPlan } from '@/api/queries';

afterEach(() => {
  cleanup();
});

function makePlan(overrides: Partial<BundleImportPlan> = {}): BundleImportPlan {
  return {
    manifest: {
      andes_version: '2.0.0',
      andes_app_version: '0.1.0.dev0',
      case_filename: 'ieee14.raw',
      case_sha256: 'abc',
      disturbance_count: 0,
      exported_at: '2026-05-09T00:00:00+00:00',
      files: ['case/ieee14.raw', 'manifest.json'],
    },
    case_files: ['ieee14.raw'],
    conflicts: [],
    blocked: false,
    has_conflicts: false,
    ...overrides,
  };
}

describe('<BundleConflictResolver />', () => {
  it('renders nothing when the plan has no conflicts', () => {
    const plan = makePlan();
    const { container } = render(
      <BundleConflictResolver plan={plan} useBundleCase={true} onUseBundleCaseChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the andes-version warning banner with both versions visible', () => {
    const plan = makePlan({
      conflicts: [
        {
          kind: 'andes-version',
          severity: 'warning',
          message: 'Bundle was exported against ANDES 99.0.0; current install is 2.0.0.',
          filename: null,
          bundle_meta: null,
          workspace_meta: null,
          bundle_andes_version: '99.0.0',
          current_andes_version: '2.0.0',
        },
      ],
      has_conflicts: true,
    });
    render(
      <BundleConflictResolver plan={plan} useBundleCase={true} onUseBundleCaseChange={vi.fn()} />,
    );
    const banner = screen.getByTestId('bundle-conflict-andes-version');
    expect(banner).toHaveTextContent(/version mismatch/i);
    expect(banner).toHaveTextContent('99.0.0');
    expect(banner).toHaveTextContent('2.0.0');
  });

  it('renders addfile-missing blocker with the Re-export CTA when wired', async () => {
    const onReExport = vi.fn();
    const plan = makePlan({
      conflicts: [
        {
          kind: 'addfile-missing',
          severity: 'blocker',
          message: 'Bundle manifest references case/ieee14.dyr but the file is not in the archive.',
          filename: 'ieee14.dyr',
          bundle_meta: null,
          workspace_meta: null,
          bundle_andes_version: null,
          current_andes_version: null,
        },
      ],
      blocked: true,
      has_conflicts: true,
    });
    const user = userEvent.setup();
    render(
      <BundleConflictResolver
        plan={plan}
        useBundleCase={true}
        onUseBundleCaseChange={vi.fn()}
        onReExportClick={onReExport}
      />,
    );
    const banner = screen.getByTestId('bundle-conflict-addfile-missing-ieee14.dyr');
    expect(banner).toHaveTextContent(/addfile missing/i);
    expect(banner).toHaveTextContent('ieee14.dyr');
    await user.click(screen.getByTestId('bundle-conflict-reexport'));
    expect(onReExport).toHaveBeenCalledOnce();
  });

  it('renders the sha-mismatch side-by-side diff with both metadata cards', () => {
    const plan = makePlan({
      conflicts: [
        {
          kind: 'sha-mismatch',
          severity: 'warning',
          message: 'Workspace already has ieee14.raw with a different checksum.',
          filename: 'ieee14.raw',
          bundle_meta: {
            filename: 'ieee14.raw',
            sha256: 'b'.repeat(64),
            size_bytes: 100,
          },
          workspace_meta: {
            filename: 'ieee14.raw',
            sha256: 'w'.repeat(64),
            size_bytes: 200,
          },
          bundle_andes_version: null,
          current_andes_version: null,
        },
      ],
      has_conflicts: true,
    });
    render(
      <BundleConflictResolver plan={plan} useBundleCase={true} onUseBundleCaseChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bundle-conflict-sha-mismatch-ieee14.raw')).toBeInTheDocument();
    const bundleSide = screen.getByTestId('bundle-conflict-bundle-side');
    expect(bundleSide).toHaveTextContent(/100 B/);
    const workspaceSide = screen.getByTestId('bundle-conflict-workspace-side');
    expect(workspaceSide).toHaveTextContent(/200 B/);
    // Sha256 hashes are abbreviated for display but the full value is
    // available via the title attribute.
    expect(bundleSide.querySelector('[title]')).not.toBeNull();
  });

  it('sha-mismatch radio toggles fire the onUseBundleCaseChange callback', async () => {
    const onChange = vi.fn();
    const plan = makePlan({
      conflicts: [
        {
          kind: 'sha-mismatch',
          severity: 'warning',
          message: '...',
          filename: 'ieee14.raw',
          bundle_meta: {
            filename: 'ieee14.raw',
            sha256: 'b',
            size_bytes: 1,
          },
          workspace_meta: {
            filename: 'ieee14.raw',
            sha256: 'w',
            size_bytes: 1,
          },
          bundle_andes_version: null,
          current_andes_version: null,
        },
      ],
      has_conflicts: true,
    });
    const user = userEvent.setup();
    // Start with useBundleCase=true so the workspace radio is unchecked
    // and clicking it fires the onChange. Re-render with the new value
    // to verify the bundle radio also fires when its state flips.
    const { rerender } = render(
      <BundleConflictResolver plan={plan} useBundleCase={true} onUseBundleCaseChange={onChange} />,
    );
    await user.click(screen.getByTestId('bundle-conflict-pick-workspace'));
    expect(onChange).toHaveBeenCalledWith(false);

    onChange.mockClear();
    rerender(
      <BundleConflictResolver plan={plan} useBundleCase={false} onUseBundleCaseChange={onChange} />,
    );
    await user.click(screen.getByTestId('bundle-conflict-pick-bundle'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('renders multiple conflicts in order', () => {
    const plan = makePlan({
      conflicts: [
        {
          kind: 'andes-version',
          severity: 'warning',
          message: 'Version mismatch.',
          filename: null,
          bundle_meta: null,
          workspace_meta: null,
          bundle_andes_version: '2.1.0',
          current_andes_version: '2.0.0',
        },
        {
          kind: 'sha-mismatch',
          severity: 'warning',
          message: 'Workspace differs.',
          filename: 'ieee14.raw',
          bundle_meta: { filename: 'ieee14.raw', sha256: 'a', size_bytes: 1 },
          workspace_meta: {
            filename: 'ieee14.raw',
            sha256: 'b',
            size_bytes: 1,
          },
          bundle_andes_version: null,
          current_andes_version: null,
        },
      ],
      has_conflicts: true,
    });
    render(
      <BundleConflictResolver plan={plan} useBundleCase={true} onUseBundleCaseChange={vi.fn()} />,
    );
    expect(screen.getByText(/Resolve 2 conflicts/)).toBeInTheDocument();
    expect(screen.getByTestId('bundle-conflict-andes-version')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-conflict-sha-mismatch-ieee14.raw')).toBeInTheDocument();
  });
});
