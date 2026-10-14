#include <math.h>

/* One libm implementation for the desktop worker and command-line tests. */
double rf_sin(double x) { return sin(x); }
double rf_cos(double x) { return cos(x); }
double rf_tan(double x) { return tan(x); }
double rf_atan(double x) { return atan(x); }
double rf_atan2(double x, double y) { return atan2(x, y); }
double rf_pow(double x, double y) { return pow(x, y); }
double rf_log(double x) { return log(x); }
double rf_log2(double x) { return log2(x); }
double rf_log10(double x) { return log10(x); }
double rf_exp(double x) { return exp(x); }
double rf_sqrt(double x) { return sqrt(x); }
