import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { RequestError } from "@octokit/request-error";

import { Events, Inputs, State } from "./constants";
import { IStateProvider } from "./stateProvider";
import * as utils from "./utils/actionUtils";

// Catch and log any unhandled exceptions.  These exceptions can leak out of the uploadChunk method in
// @actions/toolkit when a failed upload closes the file descriptor causing any in-process reads to
// throw an uncaught exception.  Instead of failing this action, just warn.
process.on("uncaughtException", e => utils.logWarning(e.message));

async function saveImpl(stateProvider: IStateProvider): Promise<number | void> {
    let cacheId = -1;
    try {
        if (!utils.isCacheFeatureAvailable()) {
            return;
        }

        if (!utils.isValidEvent()) {
            utils.logWarning(
                `Event Validation Error: The event type ${
                    process.env[Events.Key]
                } is not supported because it's not tied to a branch or tag ref.`
            );
            return;
        }

        // If restore has stored a primary key in state, reuse that
        // Else re-evaluate from inputs
        const primaryKey =
            stateProvider.getState(State.CachePrimaryKey) ||
            core.getInput(Inputs.Key);

        if (!primaryKey) {
            utils.logWarning(`Key is not specified.`);
            return;
        }

        // If matched restore key is same as primary key, then do not save cache
        // NO-OP in case of SaveOnly action
        const restoredKey = stateProvider.getCacheState();

        if (utils.isExactKeyMatch(primaryKey, restoredKey)) {
            core.info(
                `Cache hit occurred on the primary key ${primaryKey}`
            );
            if (!core.getBooleanInput(Inputs.Update)) {
                core.info("`update` option is false. Not saving cache.");
                return;
            }
            if (!process.env.GITHUB_TOKEN) {
                core.info("`update` option is true, but env var GITHUB_TOKEN is empty. Not saving cache. Please set the GITHUB_TOKEN variable to ${{secrets.GITHUB_TOKEN}}");
                return;
            }
            const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
            const [owner, repo] = process.env.GITHUB_REPOSITORY!.split("/");

            // delete existing cache
            try {
                await octokit.request('DELETE /repos/{owner}/{repo}/actions/caches{?key,ref}', {
                    owner: owner,
                    repo: repo,
                    key: primaryKey,
                    ref: process.env.GITHUB_REF
                })
                core.info("Deleted old cache");
            } catch (e) {
                if (e instanceof RequestError && e.status == 404) {
                    core.info("Old cache to delete was not found");
                } else {
                    throw e;
                }
            }
        }

        // save (upload) cache

        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: true
        });

        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );

        cacheId = await cache.saveCache(
            cachePaths,
            primaryKey,
            { uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize) },
            enableCrossOsArchive
        );

        if (cacheId != -1) {
            core.info(`Cache saved with key: ${primaryKey}`);
        }
    } catch (error: unknown) {
        utils.logWarning((error as Error).message);
    }
    return cacheId;
}

export default saveImpl;
