# Raycast icon assets

- Put command icon files in `assets/` as transparent 512×512 PNGs.
- In `package.json`, reference an asset by its filename relative to `assets/` (for example, `"icon": "drive.png"`), not by prefixing `assets/`.
- Rebuild the extension after changing a manifest icon so the updated asset is copied into Raycast's installed extension.
