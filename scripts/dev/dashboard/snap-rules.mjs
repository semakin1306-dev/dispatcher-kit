// snap-rules.mjs — как долго запись слота в снимке годится без нового опроса git: горячие слоты опрашиваются каждый
// проход, холодные и влитые — редко.
export const SNAP_AGE = { hot: 0, view: 60e3, orch: 60e3, cold: 10 * 60e3, merged: 15 * 60e3 };

export function snapMaxAge(o) {
    if (o.agentBusy || o.jobLive)
        return SNAP_AGE.hot;
    if (o.kind === "orch")
        return SNAP_AGE.orch;
    if (o.merged)
        return SNAP_AGE.merged;
    if (o.viewEpic && o.epic === o.viewEpic)
        return SNAP_AGE.view;
    return SNAP_AGE.cold;
}
