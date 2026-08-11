# ChudGame --- Perforce + Unreal Team Guide

> Setup, syncing, file locking, and submitting changes

## Team connection details

  -----------------------------------------------------------------------
  Setting                             Value
  ----------------------------------- -----------------------------------
  **P4 Server**                       `ssl:198.199.80.108:1666`

  **Main Stream**                     `//chudgame/main`

  **Help**                            Ask Sam if credentials, the SSL
                                      fingerprint, permissions, or locks
                                      are unclear.
  -----------------------------------------------------------------------

**Quick workflow:** **Get Latest → Check Out → Work → Save/Test →
Submit**

------------------------------------------------------------------------

## 1. What you need before starting

-   Install the same **Unreal Engine version** the team is using.
-   Install **P4V (Perforce Visual Client)** from the official Perforce
    website.
-   Get your individual Perforce username and password from Sam.
-   **Do not use the admin account.** Every teammate should use their
    own account.

## 2. Connect P4V to the team server

1.  Open **P4V**.
2.  For **Server**, enter: `ssl:198.199.80.108:1666`
3.  Enter your own Perforce username.
4.  Enter your password when prompted.
5.  On the first connection, P4V will show an **SSL
    authenticity/fingerprint warning**. Confirm the fingerprint with Sam
    before trusting it. Do not blindly trust a fingerprint that does not
    match.
6.  If P4V asks for **character encoding**, choose **UTF-8 / `utf8`**.

## 3. Create your own workspace

Every person needs a separate workspace. **Never share a workspace name
between computers.**

1.  Open the **Stream Graph** and locate: `//chudgame/main`
2.  Right-click the main stream and choose **New Workspace**.
3.  Use a unique workspace name, for example:
    -   `alex_pc_chudgame`
    -   `mike_laptop_chudgame`
4.  Choose a local **Workspace Root**, for example: `C:\P4\chudgame`
5.  Make sure the workspace is attached to `//chudgame/main`.
6.  Save the workspace.

Do **not** manually copy another teammate's project into this folder.
Your first copy should come from Perforce.

## 4. Download the project for the first time

This is roughly the Perforce equivalent of a Git **pull/clone** for your
initial setup.

1.  In P4V, make sure your new workspace is selected.
2.  Go to the **Depot** view and expand `chudgame → main`.
3.  Right-click the project/main folder and choose **Get Latest
    Revision** (or use the Get Latest toolbar button).
4.  P4V downloads the project into your Workspace Root.
5.  After the sync completes, find `chudgame.uproject` inside your
    workspace and open it.

Whenever you begin a work session, **Get Latest before making changes**.

## 5. Connect Unreal Editor to Perforce

1.  Open `chudgame.uproject` from **inside your P4 workspace**.
2.  In Unreal Engine, open the **Source Control / Revision Control**
    menu.
3.  Choose **Connect to Source Control**.
4.  Select **Perforce**.
5.  Enter:
    -   **Server:** `ssl:198.199.80.108:1666`
    -   **User:** your own Perforce username
    -   **Workspace:** the workspace you created on your computer
6.  Enter your password if requested.
7.  Choose **Accept Settings**.

Once connected, Unreal will show source-control status icons on assets.

## 6. Normal daily workflow

### A. Get Latest

Before starting work, use **Get Latest** in P4V.

If Unreal is already open, Unreal's source-control Sync/Get Latest can
be convenient for small asset updates. For a large sync, closing Unreal
first is safer.

### B. Check Out before editing

Unreal assets such as `.uasset` and `.umap` are binary files and the
server is configured with **exclusive locking**.

When Unreal asks to check out an asset, accept it. You can also
right-click an asset and choose **Source Control / Revision Control →
Check Out**.

### C. Work and save

Make your changes normally in Unreal and test them.

### D. Review your changes

Look at your **Pending changelist** in P4V or Unreal's **Submit to
Source Control** window.

Make sure only files related to your task are included.

### E. Submit

Enter a useful changelist description, for example:

-   `Add sprint mechanic to player character`
-   `Block out warehouse entrance`
-   `Fix door interaction Blueprint`

Then **Submit**.

Submitting sends your changes to the P4 server and releases exclusive
locks on submitted files.

### F. Tell teammates when relevant

If your change affects a shared system, map, Blueprint interface,
project setting, or other central asset, tell the team so they know to
sync.

## 7. Git terminology vs. Perforce terminology

  Git-style idea                    Perforce action
  --------------------------------- -------------------------------------
  Pull / update local files         **Get Latest / Sync**
  Start editing a versioned file    **Check Out / Open for Edit**
  Stage a brand-new file            **Mark for Add**
  Commit + push to central server   **Submit changelist**
  Discard unsubmitted local edits   **Revert**
  View previous versions            **File History / Revision History**

Perforce is centralized, so there is not normally a separate local
`commit` followed by `push`. **Submit** sends the changelist directly to
the server.

## 8. File locking --- important for Unreal

The server is configured so `.uasset` and `.umap` files use
**`binary+l`**, meaning exclusive locking.

If one teammate checks out a Blueprint, map, material, animation, etc.,
another teammate should not be able to check out that same file until
the first teammate **submits or reverts** it.

This prevents two people from independently changing a binary Unreal
asset that cannot be cleanly merged.

**Do not leave assets checked out unnecessarily.** Submit completed work
or revert unchanged files so teammates are not blocked.

## 9. Adding new assets/files

If you create assets inside Unreal while source control is connected,
Unreal can add them to source control.

For files created outside Unreal:

1.  Refresh the workspace in P4V.
2.  Use **Reconcile Offline Work** or **Mark for Add**.
3.  Review the pending changelist.
4.  Submit it.

A new file is **not on the server** until it has been submitted.

Generated/local folders such as these are intentionally ignored:

-   `Intermediate/`
-   `Saved/`
-   `DerivedDataCache/`
-   `.vs/`

Do not submit them.

## 10. Reverting mistakes

If you checked out a file but do not want to keep the change, **Revert**
it.

In P4V, select the pending file and choose **Revert**.

In Unreal, right-click the asset and use **Source Control / Revision
Control → Revert Files**.

> **Warning:** Reverting a modified file discards your unsubmitted local
> changes. Make sure that is what you want before confirming.

## 11. Before you submit

-   Get Latest first if other people may have changed related files.
-   Make sure the project still opens and your feature works.
-   Check your Pending changelist and remove unrelated files.
-   Use a clear changelist description explaining what changed.
-   Do not submit generated/cache folders.
-   Prefer small, logical changelists instead of one giant submission
    containing unrelated work.

## 12. Maps and shared assets

Coordinate before editing heavily shared maps or core Blueprints.

Unreal's external actor / One File Per Actor workflows can reduce
contention in some map workflows, but shared assets can still create
dependencies.

If an asset is locked by somebody else, **contact them rather than
trying to bypass the lock**.

## 13. Troubleshooting

**Cannot connect**
:   Confirm the server is exactly `ssl:198.199.80.108:1666` and your
    username/password are correct.

**SSL trust warning**
:   Verify the server fingerprint with Sam before trusting it.

**No workspaces found in Unreal**
:   Make sure P4V is logged in, your workspace exists, and
    `chudgame.uproject` is physically inside that workspace root.

**Files are read-only**
:   This is often normal in Perforce. Check the file out before editing
    it.

**Someone else has the file locked**
:   Ask that teammate to submit or revert it.

**Project looks out of date**
:   Use **Get Latest / Sync**.

**New file is not appearing for teammates**
:   Make sure it was **Marked for Add and Submitted**, not merely
    created locally.

**P4V shows unexpected files**
:   Do not submit them blindly. Ask Sam if you are unsure.

## 14. Recommended team habits

-   **Get Latest** at the beginning of every work session.
-   Sync again before submitting when teammates have been active in
    related areas.
-   Keep changelists focused and descriptions meaningful.
-   Do not work using the admin account.
-   Communicate before large changes to shared maps, game modes, player
    Blueprints, project settings, or other central systems.
-   Submit or revert locks when you finish.
-   If something looks wrong, stop before submitting. Fixing a local
    workspace is much easier than cleaning up a bad shared changelist.

## 15. Quick cheat sheet

``` text
Starting work:
    Get Latest

Editing an existing Unreal asset:
    Check Out → Edit → Save → Submit

Creating a new asset:
    Create → Mark/Add to Source Control → Submit

Getting everyone else's changes:
    Get Latest / Sync

Sending your changes to everyone:
    Submit

Changed your mind:
    Revert

Asset locked by teammate:
    Contact teammate → they Submit or Revert
```
