# Kipster Plugins reviewer additions

Review secret handling as code: token storage, refresh locking, and logs or errors that could leak tokens. Check that unreviewed tools count as write, that the probe stays read-only, and that the control API and MCP surface change only by addition. Check that the server never depends on Kipster. Compare the claimed proof with the test levels that actually ran. Kit changes always need the owner's approval.
