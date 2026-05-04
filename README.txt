========================================================
  BAMBU LABS P2S STREAM OVERLAY
  Setup Guide
  Created by Bash Creates (bashcreates.ca)
  Vibe coded with Claude (claude.ai)
========================================================

Thank you for downloading the Bambu Labs P2S Stream Overlay!
This guide will walk you through everything you need to get
it running in OBS, step by step.

--------------------------------------------------------
  WHAT'S INCLUDED
--------------------------------------------------------

  bambu_server.py      - The backend script that connects
                         to your printer and serves data
                         to the overlay.

  bambu_overlay.html   - The overlay file that displays
                         your printer info on stream.

  README.txt           - This file!

--------------------------------------------------------
  WHAT YOU'LL NEED
--------------------------------------------------------

Before you start, make sure you have the following:

  1. A Bambu Labs P2S printer on your local Wi-Fi network.

  2. Python installed on your PC.
     - Download it at: https://www.python.org/downloads/
     - During installation, CHECK the box that says
       "Add Python to PATH" — this is important!

  3. OBS Studio installed.
     - Download it at: https://obsproject.com

  4. Your printer's three pieces of info:
     a) IP Address   - found on the printer touchscreen
                       under Settings > Network
     b) Serial Number - found on the printer touchscreen
                        under Settings > Device
     c) Access Code  - found on the printer touchscreen
                       under Settings > Network
                       (look for "LAN" or "Access Code")

--------------------------------------------------------
  STEP 1 — INSTALL THE REQUIRED PYTHON PACKAGES
--------------------------------------------------------

The server script needs a couple of extra Python packages
to work. Here's how to install them:

  1. Press the Windows key on your keyboard.
  2. Type "cmd" and press Enter to open Command Prompt.
  3. Copy and paste this command and press Enter:

       pip install paho-mqtt flask flask-cors

  4. Wait for it to finish. You'll see a lot of text
     scroll by — that's normal!

  5. Once it's done you can close Command Prompt.

--------------------------------------------------------
  STEP 2 — ENTER YOUR PRINTER DETAILS
--------------------------------------------------------

  1. Open the file "bambu_server.py" in a text editor.
     (Right-click the file > Open with > Notepad,
      or use Notepad++ if you have it.)

  2. Near the top of the file, find these three lines:

       PRINTER_IP     = "192.168.1.XXX"
       PRINTER_SERIAL = "YOUR_SERIAL"
       ACCESS_CODE    = "YOUR_CODE"

  3. Replace the placeholder text with your actual values.
     For example:

       PRINTER_IP     = "192.168.1.84"
       PRINTER_SERIAL = "22E8AJ582300512"
       ACCESS_CODE    = "12345678"

     IMPORTANT: Keep the quote marks around each value!
     Only replace the text inside the quotes.

  4. Save the file (Ctrl+S).

--------------------------------------------------------
  STEP 3 — RUN THE SERVER
--------------------------------------------------------

The server script needs to be running in the background
any time you want the overlay to work.

  OPTION A — Run with no visible window (recommended
  for streaming so the black console doesn't show up):

  1. Make a copy of bambu_server.py and rename it to:
       bambu_server.pyw
     (just change the extension from .py to .pyw)

     NOTE: If you don't see file extensions in File
     Explorer, click the "View" tab at the top and
     check the box that says "File name extensions".

  2. Double-click bambu_server.pyw to run it.
     Nothing will appear on screen — that's normal!
     It's running silently in the background.

  3. To stop it, open Task Manager (Ctrl+Shift+Esc),
     find "Python" in the list, and click "End Task".

  OPTION B — Run with the console window visible
  (useful for troubleshooting if something isn't working):

  1. Open the folder where you saved bambu_server.py
     in File Explorer.

  2. Right-click on an empty space in the folder
     (not on a file) and click:
       "Open in Terminal"
     or
       "Open PowerShell window here"

  3. Type the following and press Enter:

       python bambu_server.py

  4. You should see some messages appear, including:
       "Connecting to [your IP]..."
       "Running on http://127.0.0.1:5000"

     Leave this window open in the background —
     don't close it.

--------------------------------------------------------
  STEP 4 — ADD THE OVERLAY TO OBS
--------------------------------------------------------

  1. Open OBS Studio.

  2. In the "Sources" panel at the bottom, click the
     "+" button.

  3. Select "Browser" from the list.

  4. Give it a name like "Bambu Overlay" and click OK.

  5. In the URL field, type:

       http://localhost:5000/overlay

  6. Set the Width to 1920 and Height to 1080.

  7. Click OK.

  8. The overlay should now appear in your OBS preview!
     You can move and resize it like any other source.

     TIP: Right-click the source and choose "Filters"
     to add a Chroma Key or Color Correction if needed.

--------------------------------------------------------
  TROUBLESHOOTING
--------------------------------------------------------

  The overlay shows "Connecting..." and never updates:
  > Make sure bambu_server.py is still running in the
    background. Check that your printer is on and
    connected to the same Wi-Fi as your PC.

  The .pyw file runs but the overlay still doesn't work:
  > Since .pyw runs silently you can't see errors. Switch
    to Option B (running via Terminal) temporarily so you
    can see any error messages and diagnose the problem.

  I see an error when running bambu_server.py:
  > Double-check your PRINTER_IP, PRINTER_SERIAL, and
    ACCESS_CODE values. Make sure the quote marks are
    still around each value.

  "pip" is not recognized as a command:
  > Python may not have been added to PATH during
    installation. Try uninstalling Python and reinstalling
    it, making sure to check "Add Python to PATH" on the
    first screen of the installer.

  OBS shows a blank/black browser source:
  > Make sure the server is running first, then try
    right-clicking the browser source in OBS and
    choosing "Refresh cache of current page".

--------------------------------------------------------
  NOTES
--------------------------------------------------------

  - You must start bambu_server.py BEFORE going live
    each time you stream. It does not start automatically.

  - If your printer's IP address changes (this can happen
    if your router restarts), you'll need to update the
    PRINTER_IP value in bambu_server.py again.

  - To set a static IP for your printer so it never
    changes, look in your router's settings for "DHCP
    Reservation" or "Static IP" and assign one to your
    printer's MAC address.

  - This overlay was built for the Bambu Labs P2S.
    It may work on other Bambu printers but has only
    been tested on the P2S.

--------------------------------------------------------
  CREDITS
--------------------------------------------------------

  Concept & Testing:  Bash Creates (bashcreates.ca)
  Code:               Claude by Anthropic (claude.ai)

  Follow Bash Creates:
    Twitch:    twitch.tv/bashcreates
    TikTok:    tiktok.com/@bash.creates
    Discord:   discord.gg/uKRuKWjbXw
    Bluesky:   bsky.app/profile/bashcreates.bsky.social

========================================================
  Happy printing and happy streaming!
========================================================
