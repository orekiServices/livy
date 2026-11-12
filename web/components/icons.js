'use client'

/**
 * Every icon in the console, in one place.
 *
 * One family — [Solar](https://www.figma.com/community/file/1166831539721848736)
 * — in one weight, because a UI that mixes icon sets looks like three
 * people built it. Solar's "Bold" set matches YouTube Music's filled
 * glyphs; the tab bar uses Bold when selected and Linear when not, which is
 * exactly the trick YT Music uses to show where you are.
 *
 * Re-exported through this file so a screen imports `Play` rather than
 * `PlayBold`, and so swapping a glyph is a one-line change here instead of
 * a search across the app.
 */
export {
  // transport
  PlayBold as Play,
  PauseBold as Pause,
  SkipNextBold as SkipNext,
  RewindBackBold as Rewind,
  RefreshBold as Refresh,
  // navigation
  HomeAngle2Bold as HomeOn,
  HomeAngle2Linear as HomeOff,
  MagniferBold as SearchOn,
  MagniferLinear as SearchOff,
  MusicLibrary2Bold as LibraryOn,
  MusicLibrary2Linear as LibraryOff,
  Tuning4Bold as StudioOn,
  Tuning4Linear as StudioOff,
  // objects
  MusicNote2Bold as Note,
  MusicNoteSlider2Bold as Mixer,
  MicrophoneLargeBold as Mic,
  PlaylistBold as Queue,
  RadioBold as RadioIcon,
  VolumeLoudBold as Volume,
  SoundwaveBold as Waveform,
  WidgetBold as Plugins,
  TextBold as Lyrics,
  // affordances
  AltArrowDownLinear as ChevronDown,
  AltArrowRightLinear as ChevronRight,
  CloseCircleBold as Close,
  AddCircleBold as Add,
  MenuDotsBold as More,
  HamburgerMenuLinear as DragHandle,
  CopyBold as Copy,
  CheckCircleBold as Check,
  DangerTriangleBold as Warning
} from 'solar-icon-set'
