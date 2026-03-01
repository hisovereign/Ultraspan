# Ultraspan 

- Combined single-span wallpaper Manager

Ultraspan is a command-line tool that aims to be a true workaround to the **blurry wallpaper bug** in Linux Mint Cinnamon when using multiple monitors. 

It pre-renders the final image using ImageMagick, bypassing Cinnamon's caching and scaling. 

## Features


- **Spans a single image across all monitors**

- **Zoom, fit, and center modes**

- **Random rotation**

- **command-line interface**

## Requirements


- **ImageMagick** (convert, identify)

- **xrandr** - usually installed by default with x11

- **gesettings** 

- **sha1sum**

- **bc** 


Install dependencies

    sudo apt install imagemagick x11-utils bc


### Installation

1. Download Ultraspan script
    
    - click on ulstraspan script and go to the right of where it says raw then click download raw file

2. Move it to ~/.local/bin/

    - if you don't see .local right click and show hidden files

3. Make the script executable

    - Open a terminal by going to menu and searching terminal

    - Type and hit enter

          chmod +x ultraspan
    - Then type 

          ultraspan

to bring up help menu


### How to use

Type in terminal: ultraspan COMMAND [arguments]

**Commands**

| Command | Description |
|---------|-------------|
|set IMAGE_PATH [MODE] | Set wallpaper from image file, optionally with a mode (zoom/fit/center).|
|mode [MODE] | Show or set default mode (zoom, fit, center).|
|bg-type [TYPE] | Show or set background type (blur, solid).|
|blur [0-100] | Show or set blur amount (default 15).|
|color [HEX] | Show or set solid background color (e.g., #000000).|
|random DIRECTORY [MODE] | Start random rotation from a folder of images.|
|random-stop | Stop the running random rotation.|
|random-status | Show status of random rotation.|
|interval [MINUTES] | Show or set random rotation interval (default 30).|
|list | List recent wallpapers and cached files.|
|status | Display current settings, monitor layout, and active random rotation.|
|info IMAGE_PATH | Show image details and preview dimensions for current monitor layout.|
|restore | Restore default system wallpaper (if found).|
|clean | Delete all cached wallpaper images.|
|help | Show this help message.|


**Examples**

- Set a wallpaper with default mode (zoom)

      ultraspan set ~/Pictures/wallpaper.jpg

- Start random rotation every 15 minutes using center mode

      ultraspan random ~/Wallpapers center
      ultraspan interval 15

- Set with fit mode and solid background

      ultraspan set ~/Pictures/landscape.jpg fit

      ultraspan color "#3498db"

**Acknowledgments**

- Monitor geometry logic detection adaptaded from [`fade-monitors`](https://github.com/hisovereign/fade-monitors) script
