// The settings screen's 기기 page (DESIGN.md 2d, 2e): pair a phone with a QR code or a desktop app
// with a link and a short code, list the paired devices and cut one off, and download the Android
// and desktop apps. Inside the desktop app (window.maruDesktop) the page shows this device and the
// app's own update instead of device management, which a device token cannot reach. Drawn with the
// settings rows (settingsLayout.tsx, after T3 Code) and the app's T3 dialog parts.
import type { DesktopAppInfo, DesktopArtifact, DeviceInfo, DeviceKind, MaruDesktopBridge, MobileAppInfo, PairingClaimed, PairingOffer } from "@maru/shared";
import { CheckIcon, CopyIcon, DownloadIcon, LaptopIcon, RotateCwIcon, SmartphoneIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, describeError } from "~/projectsApi";
import { APK_PATH, desktopDownloadPath, fetchDesktopApp, fetchDevices, fetchMobileApp, pairingStreamPath, removeDevice } from "~/lib/devicesApi";
import { desktopBridge, describeDesktopUpdate, useDesktopUpdate } from "~/lib/desktopBridge";
import { formatSize, formatWhen } from "./parts";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";

/** A server read: loading, its value, or why it failed. Each list on the page has its own. */
type Loaded<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; error: string };

/** Why a read failed; a server without the device routes (an older release) answers 404. */
function readError(e: unknown): string {
  return e instanceof ApiError && e.status === 404 ? "This server has no device support (404)" : describeError(e);
}

const KIND_LABEL: Record<DeviceKind, string> = { android: "Android", desktop: "desktop" };

/** One server read with its own sequence: an answer to an older read (overtaken by a retry) is dropped. */
function useRead<T>(read: () => Promise<T>): [Loaded<T>, () => void] {
  const [value, setValue] = useState<Loaded<T>>({ state: "loading" });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    read().then(
      (v) => mine === seq.current && setValue({ state: "ok", value: v }),
      (e: unknown) => mine === seq.current && setValue({ state: "error", error: readError(e) }),
    );
  }, [read]);
  const retry = useCallback(() => {
    setValue({ state: "loading" });
    reload();
  }, [reload]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the page reads the server's lists once when it opens
  useEffect(() => reload(), [reload]);
  return [value, retry];
}

export function DevicesPanel() {
  const bridge = desktopBridge();
  const [app, retryApp] = useRead(fetchMobileApp);
  const [desktop, retryDesktop] = useRead(fetchDesktopApp);
  return (
    <SettingsPageContainer>
      {bridge ? <ThisDesktopSection bridge={bridge} /> : <DevicesSection />}

      <SettingsSection title="Desktop app">
        {desktop.state === "loading" ? <SettingsRow title="Loading" /> : null}
        {desktop.state === "error" ? <ReadFailed error={desktop.error} onRetry={retryDesktop} /> : null}
        {desktop.state === "ok" ? <DesktopRows info={desktop.value} /> : null}
      </SettingsSection>

      <SettingsSection title="Android app">
        {app.state === "loading" ? <SettingsRow title="Loading" /> : null}
        {app.state === "error" ? <ReadFailed error={app.error} onRetry={retryApp} /> : null}
        {app.state === "ok" ? <AppRows app={app.value} /> : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** The browser's device management: the list, removing one, and pairing a new phone or desktop app. */
function DevicesSection() {
  const [devices, retryDevices] = useRead(fetchDevices);
  const [pairing, setPairing] = useState<DeviceKind | null>(null);
  const [removing, setRemoving] = useState<DeviceInfo | null>(null);
  return (
    <SettingsSection
      title="Connected devices"
      headerAction={
        <div className="flex gap-1.5">
          <Button size="xs" variant="outline" onClick={() => setPairing("android")}>
            <SmartphoneIcon />
            Connect Android
          </Button>
          <Button size="xs" variant="outline" onClick={() => setPairing("desktop")}>
            <LaptopIcon />
            Connect desktop
          </Button>
        </div>
      }
    >
      {devices.state === "loading" ? <SettingsRow title="Loading" /> : null}
      {devices.state === "error" ? <ReadFailed error={devices.error} onRetry={retryDevices} /> : null}
      {devices.state === "ok" && devices.value.length === 0 ? <SettingsRow title="No connected devices" /> : null}
      {(devices.state === "ok" ? devices.value : []).map((d) => (
        <SettingsRow
          key={d.id}
          title={d.name}
          description={`${KIND_LABEL[d.kind ?? "android"]}, connected ${formatWhen(d.createdAt)}, last used ${d.lastUsedAt ? formatWhen(d.lastUsedAt) : "never"}`}
          control={
            <Button size="xs" variant="destructive-outline" onClick={() => setRemoving(d)}>
              Disconnect
            </Button>
          }
        />
      ))}
      <PairingDialog kind={pairing} onClose={() => setPairing(null)} onPaired={retryDevices} />
      <RemoveDialog
        device={removing}
        title={removing ? `Disconnect ${removing.name}` : ""}
        detail="This device's token is blocked at once and open connections are closed. Pair it again to use it later."
        onClose={() => setRemoving(null)}
        run={async () => {
          await removeDevice(removing!.id);
          retryDevices();
        }}
      />
    </SettingsSection>
  );
}

/**
 * Inside the desktop app: this device, the app's own version and update, and unpairing. The
 * device list and pairing stay behind Google sign-in (the web in a browser).
 */
function ThisDesktopSection({ bridge }: { bridge: MaruDesktopBridge }) {
  const update = useDesktopUpdate();
  const [device, setDevice] = useState<{ name: string; server: string } | null>(null);
  const [unpairing, setUnpairing] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shell knows the device; read once
  useEffect(() => {
    void bridge.getDevice().then(setDevice, () => setDevice(null));
  }, [bridge]);
  const busy = update?.status === "checking" || update?.status === "downloading" || update?.status === "disabled";
  return (
    <SettingsSection title="This device">
      <SettingsRow
        title={device?.name ?? "Loading"}
        description={device ? `desktop, server ${device.server}` : undefined}
        control={
          <Button size="xs" variant="destructive-outline" onClick={() => setUnpairing(true)}>
            Disconnect
          </Button>
        }
      />
      <SettingsRow
        title="App"
        description={describeDesktopUpdate(update, bridge.version)}
        control={
          update?.status === "downloaded" ? (
            <Button size="xs" variant="outline" onClick={() => void bridge.installUpdate()}>
              <RotateCwIcon />
              Restart
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void bridge.checkForUpdate()}>
              Check for updates
            </Button>
          )
        }
      />
      <SettingsRow
        title="Other devices"
        description="Manage devices in maru on the web, in a browser"
      />
      <RemoveDialog
        device={unpairing ? { id: "", name: device?.name ?? "" } : null}
        title="Disconnect this device?"
        detail="The server deletes this device's token and the app returns to the connect screen. Connect again from the web to use it later."
        onClose={() => setUnpairing(false)}
        run={() => bridge.unpair()}
      />
    </SettingsSection>
  );
}

/** A list the server did not give (T3's archived-thread error row): what failed, and a retry. */
function ReadFailed(props: { error: string; onRetry: () => void }) {
  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-2">
          <TriangleAlertIcon className="size-3.5 text-warning-foreground" />
          Could not load
        </span>
      }
      description={props.error}
      control={
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          <RotateCwIcon />
          Reload
        </Button>
      }
    />
  );
}

/** What each downloadable file is, and what its first start asks of the user. */
function artifactTitle(a: DesktopArtifact): string {
  if (a.platform === "win32") return "Windows";
  return a.arch === "arm64" ? "Mac (Apple silicon)" : "Mac (Intel)";
}

const FIRST_START: Record<DesktopArtifact["platform"], string> = {
  darwin: "Open the dmg and move the app to the Applications folder. If macOS blocks it on first open, press Open Anyway in System Settings, Privacy & Security.",
  win32: "Run the installer. If Windows shows a PC protection window, press More info, then Run anyway.",
};

function DesktopRows({ info }: { info: DesktopAppInfo }) {
  const build = info.build;
  if (!build) return <SettingsRow title="No desktop app build" />;
  // The install files; the Mac zip is what an installed app updates itself from.
  const files = build.artifacts.filter((a) => a.format !== "zip");
  return (
    <>
      {files.map((a) => (
        <SettingsRow
          key={a.file}
          title={artifactTitle(a)}
          description={`${build.version}, built ${formatWhen(Date.parse(build.builtAt))}, ${formatSize(a.size)}`}
          status={FIRST_START[a.platform]}
          control={
            <Button size="xs" variant="outline" render={<a href={desktopDownloadPath(a.file)} download={a.file} />}>
              <DownloadIcon />
              Download
            </Button>
          }
        />
      ))}
    </>
  );
}

function AppRows({ app }: { app: MobileAppInfo }) {
  const { apk, update } = app;
  const stale = apk && update && apk.runtimeVersion !== update.runtimeVersion;
  return (
    <>
      <SettingsRow
        title="APK"
        description={apk ? `${apk.version ? `${apk.version}, ` : ""}built ${formatWhen(Date.parse(apk.builtAt))}, ${formatSize(apk.size)}, runtime ${apk.runtimeVersion.slice(0, 12)}` : "No APK build"}
        status={stale ? "Runtime version differs from the update, a new APK is needed" : undefined}
        control={
          apk ? (
            <Button size="xs" variant="outline" render={<a href={APK_PATH} download={apk.file} />}>
              <DownloadIcon />
              Download APK
            </Button>
          ) : null
        }
      />
      <SettingsRow
        title="Update"
        description={
          update
            ? `${update.version ? `${update.version}, ` : ""}signed ${formatWhen(Date.parse(update.createdAt))}, id ${update.id.slice(0, 8)}, runtime ${update.runtimeVersion.slice(0, 12)}`
            : "No OTA update"
        }
      />
    </>
  );
}

type PairingState =
  | { phase: "connecting" }
  | { phase: "open"; offer: PairingOffer }
  | { phase: "claimed"; device: DeviceInfo }
  | { phase: "failed"; error: string };

/**
 * Holds the pairing stream open while the dialog is open: the server's code works only that long,
 * and once. Closing the dialog closes the stream and so the code. A phone reads the QR; a desktop
 * app takes the link (pasted, or opened on this computer) or the server address and short code.
 */
function PairingDialog(props: { kind: DeviceKind | null; onClose: () => void; onPaired: () => void }) {
  const { kind, onPaired } = props;
  const [state, setState] = useState<PairingState>({ phase: "connecting" });
  const [copied, setCopied] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the event stream is the pairing code's lifetime
  useEffect(() => {
    if (!kind) return;
    setState({ phase: "connecting" });
    setCopied(false);
    const es = new EventSource(pairingStreamPath(kind));
    es.addEventListener("code", (e) => setState({ phase: "open", offer: JSON.parse((e as MessageEvent<string>).data) as PairingOffer }));
    es.addEventListener("claimed", (e) => {
      // Closed before the server ends the stream, so EventSource does not reconnect for a new code.
      es.close();
      setState({ phase: "claimed", device: (JSON.parse((e as MessageEvent<string>).data) as PairingClaimed).device });
      onPaired();
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setState({ phase: "failed", error: "The server could not open pairing" });
      else setState({ phase: "connecting" });
    };
    return () => es.close();
  }, [kind, onPaired]);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false));
  };
  const desktop = kind === "desktop";

  return (
    <Dialog open={kind !== null} onOpenChange={(next) => !next && props.onClose()}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{desktop ? "Connect desktop app" : "Connect new device"}</DialogTitle>
          <DialogDescription>
            {desktop
              ? "On this computer, press Open in app. On another computer, enter the server address and code on the app's connect screen. It works once, while this window is open."
              : "Scan the QR in the maru app or paste the link. It works once, while this window is open."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col items-center gap-3">
          {state.phase === "connecting" ? (
            <div className="flex h-60 items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" />
              Creating code
            </div>
          ) : null}
          {state.phase === "failed" ? <p className="py-8 text-sm text-destructive-foreground">{state.error}</p> : null}
          {state.phase === "claimed" ? (
            <div className="flex h-60 flex-col items-center justify-center gap-2 text-sm">
              <CheckIcon className="size-8 text-success-foreground" />
              <span>{state.device.name} connected</span>
            </div>
          ) : null}
          {state.phase === "open" && desktop ? (
            <>
              <div className="flex w-full flex-col gap-1 rounded-xl border border-border px-4 py-3">
                <span className="text-xs text-muted-foreground">Server address</span>
                <span className="font-mono text-sm break-all select-all">{state.offer.server}</span>
                <span className="mt-2 text-xs text-muted-foreground">Code</span>
                <span className="font-mono text-2xl tracking-wider select-all" data-short-code="">
                  {state.offer.shortCode}
                </span>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="xs" variant="outline" render={<a href={state.offer.link} />}>
                  <LaptopIcon />
                  Open in the app on this computer
                </Button>
                <Button size="xs" variant="outline" onClick={() => copy(state.offer.link)}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
              </div>
            </>
          ) : null}
          {state.phase === "open" && !desktop ? (
            <>
              <div className="rounded-xl bg-white p-3">
                <QRCodeSvg value={state.offer.link} size={224} level="M" title="Pairing QR" />
              </div>
              <p className="text-center text-xs text-muted-foreground">
                Server <span className="font-mono">{state.offer.server}</span>
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="xs" variant="outline" onClick={() => copy(state.offer.link)}>
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <Button size="xs" variant="outline" render={<a href={state.offer.link} />}>
                  <SmartphoneIcon />
                  Open in the app on this phone
                </Button>
              </div>
            </>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<DialogAction variant="outline" />}>{state.phase === "claimed" ? "Close" : "Cancel"}</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A confirm for cutting a device off: the web's 끊기, or the desktop app unpairing itself. */
function RemoveDialog(props: { device: Pick<DeviceInfo, "id" | "name"> | null; title: string; detail: string; onClose: () => void; run: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.run();
      props.onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={props.device !== null} onOpenChange={(next) => !next && !busy && props.onClose()}>
      <DialogPopup className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.detail}</DialogDescription>
        </DialogHeader>
        {error ? <DialogPanel><p className="text-sm text-destructive-foreground">{error}</p></DialogPanel> : null}
        <DialogFooter>
          <DialogClose render={<DialogAction variant="outline" />} disabled={busy}>
            Cancel
          </DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void go()}>
            Disconnect
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
