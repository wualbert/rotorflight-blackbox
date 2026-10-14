// f64 reconstruction algebra. Keep the source operation order: no reassociation.
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

typedef struct { int n; double *weight; double **tape; int stages; } Observation;
typedef struct { int at, first, n; double *weights; } Event;
typedef struct {
    int count, split, averages, *average, *eventCount;
    Event **events;
    double **drive, **allpole;
} Jacobian;
typedef struct {
    int n, nf, step, pp, stages, observations;
    double **tape, *gyroWeight, *rawWeight;
    Observation *observation;
    Jacobian *jacobian;
    double damping, regularization, rcp;
    double *vectors, *means;
} Solver;
_Static_assert(sizeof(Observation)==16,"Wasm observation layout");
_Static_assert(sizeof(Event)==16,"Wasm event layout");
_Static_assert(sizeof(Jacobian)==32,"Wasm Jacobian layout");

static void stage(const double *x, const double *c, int n, int transpose, double *y, double *g) {
    if (!transpose) {
        double x1=0, x2=0, y1=0, y2=0;
        for (int i=0;i<n;i++) {
            int k=i*6;
            double v=c[k]*x[i]+c[k+1]*x1+c[k+2]*x2-c[k+3]*y1-c[k+4]*y2;
            y[i]=x[i]+c[k+5]*(v-x[i]);
            x2=x1; x1=x[i]; y2=y1; y1=v;
        }
    } else {
        memset(y,0,n*sizeof(double));
        for (int i=0;i<n;i++) g[i]=x[i]*c[i*6+5];
        for (int i=n-1;i>=0;i--) {
            int k=i*6; double v=g[i];
            y[i]+=(1-c[k+5])*x[i]+c[k]*v;
            if(i>0) { y[i-1]+=c[k+1]*v; g[i-1]-=c[k+3]*v; }
            if(i>1) { y[i-2]+=c[k+2]*v; g[i-2]-=c[k+4]*v; }
        }
    }
}
static void chain(const double *x, double **tape, int stages, int n, int transpose, double *out, double *scratch, double *g) {
    if(!stages) {memcpy(out,x,n*sizeof(double));return;}
    double state[4*stages];memset(state,0,sizeof(state));
    if(!transpose) {
        for(int i=0;i<n;i++) {
            double value=x[i]; int k=i*6;
            for(int j=0;j<stages;j++) {
                double *s=state+j*4,*c=tape[j];
                double v=c[k]*value+c[k+1]*s[0]+c[k+2]*s[1]-c[k+3]*s[2]-c[k+4]*s[3];
                double next=value+c[k+5]*(v-value);
                s[1]=s[0];s[0]=value;s[3]=s[2];s[2]=v;value=next;
            }
            out[i]=value;
        }
    } else {
        for(int i=n-1;i>=0;i--) {
            double value=x[i];int k=i*6;
            for(int j=stages-1;j>=0;j--) {
                double *s=state+j*4,*c=tape[j];
                double v=value*c[k+5],y=0;
                // Match the original reverse accumulation order: i+2, i+1, i.
                if(i+2<n){v-=c[k+16]*s[1];y+=c[k+14]*s[1];}
                if(i+1<n){v-=c[k+9]*s[0];y+=c[k+7]*s[0];}
                y+=(1-c[k+5])*value+c[k]*v;
                s[1]=s[0];s[0]=v;value=y;
            }
            out[i]=value;
        }
    }
}
static void main_forward(Solver *s, const double *x, double *out) {
    int n=s->nf; Jacobian *j=s->jacobian;
    double *scratch=s->vectors+4*s->n, *sg=s->vectors+5*s->n;
    if(!j) { chain(x,s->tape,s->stages,n,0,out,scratch,sg); return; }
    double *y=s->vectors+6*s->n, *next=s->vectors+7*s->n;
    double *g=s->vectors+8*s->n, *v=s->vectors+9*s->n;
    double *means=s->means;
    chain(x,s->tape,j->split,n,0,y,scratch,sg);
    for(int k=0;k<j->averages;k++) {
        double z=0;
        for(int i=j->average[k*2];i<j->average[k*2+1];i++) z+=y[i];
        means[k]=z*s->rcp;
    }
    for(int p=0;p<j->count;p++) {
        memset(g,0,n*sizeof(double));
        Event *list=j->events[p]; int count=j->eventCount[p];
        for(int z=0;z<count;z++) {
            Event *e=list+z; int end=z+1<count?list[z+1].at:n;
            if(end>n)end=n;
            double f=0;
            for(int k=0;k<e->n;k++) f+=e->weights[k]*means[k+e->first];
            for(int i=e->at;i<end;i++) g[i]=f*j->drive[p][i];
        }
        stage(g,j->allpole[p],n,0,v,sg);
        stage(y,s->tape[j->split+p],n,0,next,sg);
        for(int i=0;i<n;i++) next[i]+=v[i];
        double *swap=y;y=next;next=swap;
    }
    memcpy(out,y,n*sizeof(double));
}
static void main_transpose(Solver *s, const double *x, double *out) {
    int n=s->nf; Jacobian *j=s->jacobian;
    double *scratch=s->vectors+4*s->n, *sg=s->vectors+5*s->n;
    if(!j) { chain(x,s->tape,s->stages,n,1,out,scratch,sg); return; }
    double *y=s->vectors+6*s->n, *next=s->vectors+7*s->n;
    double *extra=s->vectors+8*s->n, *v=s->vectors+9*s->n;
    double *means=s->means;
    memcpy(y,x,n*sizeof(double));
    memset(means,0,j->averages*sizeof(double));
    for(int p=j->count-1;p>=0;p--) {
        stage(y,j->allpole[p],n,1,v,sg);
        Event *list=j->events[p]; int count=j->eventCount[p];
        for(int k=0;k<count;k++) {
            Event *e=list+k; int end=k+1<count?list[k+1].at:n;
            if(end>n)end=n;
            double f=0;
            for(int i=e->at;i<end;i++)f+=v[i]*j->drive[p][i];
            for(int i=0;i<e->n;i++)means[e->first+i]+=f*e->weights[i];
        }
        stage(y,s->tape[j->split+p],n,1,next,sg);
        double *swap=y;y=next;next=swap;
    }
    memset(extra,0,n*sizeof(double));
    for(int k=0;k<j->averages;k++) {
        double v=means[k]*s->rcp;
        for(int i=j->average[k*2];i<j->average[k*2+1];i++)extra[i]+=v;
    }
    for(int i=0;i<n;i++)y[i]+=extra[i];
    chain(y,s->tape,j->split,n,1,out,scratch,sg);
}
static void operation(Solver *s, const double *x, double *out) {
    double *down=s->vectors, *filtered=s->vectors+s->n, *g=s->vectors+2*s->n, *z=s->vectors+3*s->n;
    for(int i=0;i<s->nf;i++)down[i]=x[i*s->step];
    main_forward(s,down,filtered);
    for(int i=0;i<s->nf;i++)g[i]=s->gyroWeight[i]*filtered[i];
    double *p=s->vectors+6*s->n,*y=s->vectors+7*s->n,*q=s->vectors+8*s->n,*v=s->vectors+9*s->n;
    double *scratch=s->vectors+4*s->n,*sg=s->vectors+5*s->n;
    for(int a=0;a<s->observations;a++) {
        Observation *ob=s->observation+a;
        for(int i=0;i<ob->n;i++)p[i]=filtered[i*s->pp];
        chain(p,ob->tape,ob->stages,ob->n,0,y,scratch,sg);
        for(int i=0;i<ob->n;i++)q[i]=ob->weight[i]*y[i];
        chain(q,ob->tape,ob->stages,ob->n,1,v,scratch,sg);
        for(int i=0;i<ob->n;i++)g[i*s->pp]+=v[i];
    }
    main_transpose(s,g,z);
    memset(out,0,s->n*sizeof(double));
    for(int i=0;i<s->nf;i++)out[i*s->step]+=z[i];
    for(int i=0;i<s->n;i++)out[i]+=s->rawWeight[i]*x[i];
    for(int i=1;i<s->n-1;i++) {
        double v=s->regularization*(x[i-1]-2*x[i]+x[i+1]);
        out[i-1]+=v;out[i]-=2*v;out[i+1]+=v;
    }
    for(int i=0;i<s->n;i++)out[i]+=1e-7*x[i];
    for(int i=0;i<s->n;i++)out[i]+=s->damping*x[i];
}
static double dot(const double *a, const double *b, int n) {
    double sum=0;for(int i=0;i<n;i++)sum+=a[i]*b[i];return sum;
}

int rf_solve(int n,int nf,int step,int pp,double **tape,int stages,double *gyroWeight,double *rawWeight,
              Observation *observation,int observations,Jacobian *jacobian,double rcp,double *rhs,double *seed,
              double damping,double regularization,int iterations,int prefix,double *out,double *statistics) {
    Solver s={n,nf,step,pp,stages,observations,tape,gyroWeight,rawWeight,observation,jacobian,damping,regularization,rcp,0,0};
    s.vectors=calloc(10*n,sizeof(double));
    s.means=calloc(jacobian&&jacobian->averages?jacobian->averages:1,sizeof(double));
    double *work=calloc(4*n,sizeof(double));
    if(!s.vectors||!s.means||!work){free(work);free(s.means);free(s.vectors);return 0;}
    double *r=work,*p=work+n,*q=work+2*n,*target=work+3*n;
    memcpy(out,seed,n*sizeof(double));
    if(prefix) {
        memset(p,0,n*sizeof(double));memcpy(p,seed,prefix*sizeof(double));
        operation(&s,p,q);
        for(int i=0;i<n;i++) {target[i]=i<prefix?0:rhs[i]-q[i];out[i]=i<prefix?0:seed[i];}
    } else memcpy(target,rhs,n*sizeof(double));
    operation(&s,out,q);
    if(prefix)memset(q,0,prefix*sizeof(double));
    for(int i=0;i<n;i++)r[i]=target[i]-q[i];
    memcpy(p,r,n*sizeof(double));
    double rr=dot(r,r,n),initial=rr;int used=0;
    for(;used<iterations&&rr>fmax(1e-16,initial*1e-10);used++) {
        operation(&s,p,q);
        if(prefix)memset(q,0,prefix*sizeof(double));
        double den=dot(p,q,n);if(!(den>0))break;
        double alpha=rr/den;
        for(int i=0;i<n;i++){out[i]+=alpha*p[i];r[i]-=alpha*q[i];}
        double next=dot(r,r,n),beta=next/rr;
        for(int i=0;i<n;i++)p[i]=r[i]+beta*p[i];
        rr=next;
    }
    if(prefix)memcpy(out,seed,prefix*sizeof(double));
    statistics[0]=used;statistics[1]=sqrt(rr/fmax(initial,1e-30));
    free(work);free(s.means);free(s.vectors);
    return 1;
}
