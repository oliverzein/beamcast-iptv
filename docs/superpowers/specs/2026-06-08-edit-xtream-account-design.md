# 📝 Edit Xtream Codes Account Details Design Spec

This document details the specifications for allowing users to edit/change details (Name, URL, Username, Password) of saved Xtream Codes accounts.

## 1. Overview
Currently, the IPTV Player allows users to add and delete Xtream Codes accounts, but not modify them. Since server credentials or URLs can change, users need a way to edit existing accounts. This design adds an "Edit" option next to each account, reusing the existing add form inside the accounts modal to perform updates.

## 2. User Interface Changes

### 2.1 Accounts List
- Each list item in the saved accounts section will have an **Edit** button alongside the existing **Connect** and **Delete** buttons.
- Styling: The Edit button will match the aesthetics of other secondary action buttons (e.g. `btn-sm btn-sm-secondary` or similar styling).

### 2.2 Account Form
- A **Cancel** button (`<button type="button" id="btn-cancel-edit" class="btn btn-secondary" style="display: none; margin-top: 10px;">Cancel</button>`) will be added to the bottom of the form.
- The form header (`<h3>Add New Account</h3>`) and the submit button (`Save Profile`) will be updated dynamically depending on the current mode (Add vs. Edit).

```
+------------------------------------------+
| Xtream Codes Accounts                    |
+------------------------------------------+
| Saved Accounts      | Edit Account: My   |
| - My Account        | Profile Name       |
|   [Conn] [Edit][Del]| [ Host           ] |
| - Secondary         | [ User           ] |
|   [Conn] [Edit][Del]| [ Pass           ] |
|                     | [ Update Profile ] |
|                     | [ Cancel         ] |
+------------------------------------------+
```

## 3. State & Logic Flow

### 3.1 State Tracking
A local variable `editingAccountId` is added to `renderer.js`:
```javascript
let editingAccountId = null;
```

### 3.2 Entering Edit Mode
When the **Edit** button is clicked for an account:
1. Set `editingAccountId = account.id`.
2. Populate the form input fields:
   - `acc-name` = `account.name`
   - `acc-host` = `account.host`
   - `acc-user` = `account.username`
   - `acc-pass` = `account.password`
3. Change the section heading to `Edit Account: ${account.name}`.
4. Change the submit button text to `Update Profile`.
5. Show the `btn-cancel-edit` button.

### 3.4 Form Submission
When the form is submitted:
1. Read current input values.
2. If `editingAccountId` is not null (Edit Mode):
   - Retrieve the original account details from the database.
   - Check if `host`, `username`, or `password` has changed.
   - If any connection details changed:
     - Clear the local database cache for this account (i.e. `IPTVDb.clearAccountCache(editingAccountId)`).
     - Set `lastSync = null` (or delete the attribute) so that the next connection triggers a fresh sync.
   - Update the account object:
     ```javascript
     const updatedAccount = {
       id: editingAccountId,
       name,
       host,
       username,
       password,
       lastSync: credentialsChanged ? null : originalAccount.lastSync
     };
     ```
   - Call `await IPTVDb.addAccount(updatedAccount)` (which overwrites the existing entry in IndexedDB because it uses the same `id` key).
   - Clear edit state (reset form, hide cancel button, restore headers/buttons, set `editingAccountId = null`).
   - Reload the accounts list.
3. If `editingAccountId` is null (Add Mode):
   - Perform the standard "Add New Account" flow.

### 3.5 Canceling Edit
When the **Cancel** button is clicked:
1. Reset the form.
2. Set `editingAccountId = null`.
3. Restore section heading to `Add New Account`.
4. Restore submit button text to `Save Profile`.
5. Hide the Cancel button.

## 4. Test & Verification Plan
- **V1: Enter Edit Mode:** Check that clicking "Edit" populates the inputs, changes the header and button, and shows "Cancel".
- **V2: Cancel Edit:** Check that clicking "Cancel" resets the form and restores "Add New Account" UI.
- **V3: Save Name Only:** Check that changing only the profile name updates it in the list without clearing `lastSync` or database cache.
- **V4: Save Host/User/Pass:** Check that changing connection details clears the cache and resets `lastSync` so that connecting again triggers a full sync rather than loading from cache.
- **V5: Add New works:** Check that adding a new account still works correctly when not in edit mode.
