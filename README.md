# avantis-tally
Allows you to connect tally lights to a avantis sound console to make it visible weather a microphone is on or off.


This applications connects to the avantis console using it's hostname or IP address.
It using the TCP/IP protocol.
Specs for connecting to the console over this MIDI connection can be found at
https://www.allen-heath.com/content/uploads/2023/05/Avantis-MIDI-TCP-Protocol-V1.0.pdf

When first launching the application, it will ask you to enter the console's IP address.
The IP address can be changed later by going to file > console connection.

After the initial connection to the console, you will see a window that has a status in the
header bar. The status is either "Connecting..." or "Connected". Next to the status, you will
see information about the mixer, which includes the ip/hostname.

In the body of the window, you will see a list of the tally lights.
The list includes a status of the tally light, which is either "Disconnected" or "Connected".
After the status, it will show the name of the tally light, then it will have the name
of what fader it's connected to on the avantis console.
After the name, it will have the status of the fader, which includes the volume and if it's muted.

clicking on a tally light in the list will bring up a modal, where you can change what fader it's connected to,
and you can change the name of the tally light. You can also forget the tally light from the system.

To sync a tally light, plug it into the system, and navigate to file > Add Tally Light. From there,
a modal will open that will have a list of com ports, select the tally light from the list, and it will
sync it with the console. By default, it will use the current computer's IP address, but you may define a custom
Address by going to file > Proxy Address. Leaving it blank will set it to use the IP address.

