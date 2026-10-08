# Fit Capture (test app, version 0.1.0)

A web page that guides a person through a body capture with their phone: lean the phone against a wall,
step back, hold an A-pose, turn once. It saves a capture file (pictures from the turn plus the app's notes)
that is then turned into an avatar and measurements.

- `index.html`, `app.js`: the app. No build step.
- `vendor/pose/`: MediaPipe Pose 0.5.1675469404 (Apache License 2.0, Google), unmodified, run on the phone.

Nothing is uploaded. The camera pictures stay in the browser until the person saves the capture file.

## Hosting

Any static host with https works (the camera needs https). With GitHub Pages: put these files at the root
of a repository, then Settings -> Pages -> Deploy from a branch -> main / root.

## Testing on a computer

`python3 -m http.server 8765` in this folder, then open http://localhost:8765 . A computer has no tilt
sensor, so use "Skip the angle check". Add `?model=0` to the address for the lighter body detector.
