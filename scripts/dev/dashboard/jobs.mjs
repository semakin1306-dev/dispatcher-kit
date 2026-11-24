// jobs.mjs — список прогонов (S.jobs) и счётчик их номеров (S.seq): единственный модуль, который их меняет. Остальные
// читают jobList().
import { S } from "./state.mjs";
import { jobNum } from "./config.mjs";

export const jobList = () => S.jobs;

export const addJob = (job) => {
    S.jobs.push(job);
};

export const keepLastJobs = (n) => {
    S.jobs = S.jobs.slice(-n);
};

export const nextSeq = () => ++S.seq;

export function loadJobs(list) {
    S.jobs = list;
    S.seq = S.jobs.reduce((m, j) => Math.max(m, jobNum(j)), 0);
}
